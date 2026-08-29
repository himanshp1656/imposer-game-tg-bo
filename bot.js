import { Telegraf, Markup } from 'telegraf';
import dotenv from 'dotenv';
import http from 'http';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import { getRandomWord } from './words.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'db.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Connected to the SQLite database.');
  }
});

// Initialize database table
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS stats (
      userId INTEGER PRIMARY KEY,
      name TEXT,
      username TEXT,
      imposter_wins INTEGER DEFAULT 0,
      innocent_wins INTEGER DEFAULT 0,
      correct_votes INTEGER DEFAULT 0
    )
  `);
});

// Helper to update player stats in db
function updatePlayerStats(userId, name, username, isImposter, won, votedImposter) {
  db.get('SELECT * FROM stats WHERE userId = ?', [userId], (err, row) => {
    if (err) {
      console.error('Database query error:', err);
      return;
    }

    const impWinsAdd = (isImposter && won) ? 1 : 0;
    const innoWinsAdd = (!isImposter && won) ? 1 : 0;
    const correctVotesAdd = (!isImposter && votedImposter) ? 1 : 0;

    if (row) {
      db.run(
        `UPDATE stats SET 
          name = ?, 
          username = ?, 
          imposter_wins = imposter_wins + ?, 
          innocent_wins = innocent_wins + ?, 
          correct_votes = correct_votes + ? 
         WHERE userId = ?`,
        [name, username, impWinsAdd, innoWinsAdd, correctVotesAdd, userId],
        (err) => {
          if (err) console.error('Database update error:', err);
        }
      );
    } else {
      db.run(
        `INSERT INTO stats (userId, name, username, imposter_wins, innocent_wins, correct_votes) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, name, username, impWinsAdd, innoWinsAdd, correctVotesAdd],
        (err) => {
          if (err) console.error('Database insert error:', err);
        }
      );
    }
  });
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Error: TELEGRAM_BOT_TOKEN is not defined in .env file");
  process.exit(1);
}

const bot = new Telegraf(token);

// Simple HTTP server for hosting platforms to pass health checks
const PORT = process.env.PORT || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🚀 Imposter Game Bot is running!');
}).listen(PORT, () => {
  console.log(`🌍 Health check server listening on port ${PORT}`);
});

// Global error handler
bot.catch((err, ctx) => {
  console.error(`⚠️ Telegraf encountered an error for ${ctx.updateType}:`, err);
});

// Safe delete helper
async function safeDeleteMessage(chatId, messageId) {
  try {
    await bot.telegram.deleteMessage(chatId, messageId);
  } catch (err) {
    // Fail silently
  }
}

// Safe edit helper
async function safeTelegramEditMessageText(chatId, messageId, text, extra = {}) {
  try {
    await bot.telegram.editMessageText(chatId, messageId, null, text, extra);
  } catch (err) {
    if (err.description && (err.description.includes("message is not modified") || err.description.includes("too many requests"))) {
      return;
    }
    console.error("Error editing message:", err);
  }
}

// Helper to pin message
async function safePinMessage(chatId, messageId) {
  try {
    await bot.telegram.pinChatMessage(chatId, messageId, { disable_notification: true });
  } catch (err) {
    // Fail silently if not admin
  }
}

// Helper to unpin message
async function safeUnpinMessage(chatId, messageId) {
  try {
    await bot.telegram.unpinChatMessage(chatId, { message_id: messageId });
  } catch (err) {
    // Fail silently
  }
}

// In-memory state storage for active games
const games = new Map();

const isGroup = (ctx) => {
  return ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
};

function escapeMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/_/g, ' ')
    .replace(/\*/g, '')
    .replace(/`/g, "'");
}

function getMention(player) {
  if (player.username) {
    return escapeMarkdown(player.username);
  }
  return `[${escapeMarkdown(player.name)}](tg://user?id=${player.id})`;
}

// Render persistent board message
function renderBoardText(game) {
  let text = `✨ 🎮 *IMPOSTER GAME: CLUE PHASE (ROUND ${game.round})* 🎮 ✨\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  text += `🗣️ *Speaking Order & Clues:*\n`;
  game.speakingOrderList.forEach((player, idx) => {
    const isCurrent = idx === game.currentSpeakerIndex;
    const clue = game.clues[player.id];
    
    if (isCurrent) {
      text += `⚡️ *${idx + 1}. ${escapeMarkdown(player.name)}* ◀️ *(Active • 🕰️ 60s limit)*\n`;
    } else if (clue) {
      text += `💬 *${idx + 1}. ${escapeMarkdown(player.name)}*: _"${escapeMarkdown(clue)}"_\n`;
    } else {
      text += `💤 *${idx + 1}. ${escapeMarkdown(player.name)}*: _Waiting..._\n`;
    }
  });

  // Append previous rounds' clues
  if (game.history && game.history.length > 0) {
    text += `\n─────────────────────\n📜 *Previous Rounds' Clues:*\n`;
    game.history.forEach(h => {
      text += `*Round ${h.round}*:\n`;
      game.players.forEach(player => {
        const clue = h.clues[player.id] || 'No clue submitted ⏰';
        text += `• ${escapeMarkdown(player.name)}: _"${escapeMarkdown(clue)}"_\n`;
      });
      text += `\n`;
    });
  }

  text += `\n─────────────────────\n`;
  text += `📂 *Category*: 🕶️ _Hidden for Imposters!_\n\n`;
  text += `👇 All players must click *🔑 Reveal My Word* below to view their secret word privately!`;
  return text;
}

// Render voting board message
function renderVotingText(game) {
  const votedPlayersNames = game.players
    .filter(p => game.votes[p.id] !== undefined)
    .map(p => escapeMarkdown(p.name))
    .join(', ') || 'None';

  const totalVoted = Object.keys(game.votes).length;

  let cluesList = '';
  game.speakingOrderList.forEach((player) => {
    const clue = game.clues[player.id] || 'No clue submitted ⏰';
    cluesList += `• *${escapeMarkdown(player.name)}*: _"${escapeMarkdown(clue)}"_\n`;
  });

  // Append previous rounds' clues
  if (game.history && game.history.length > 0) {
    cluesList += `\n─────────────────────\n📜 *Previous Rounds' Clues:*\n`;
    game.history.forEach(h => {
      cluesList += `*Round ${h.round}*:\n`;
      game.players.forEach(player => {
        const clue = h.clues[player.id] || 'No clue submitted ⏰';
        cluesList += `• ${escapeMarkdown(player.name)}: _"${escapeMarkdown(clue)}"_\n`;
      });
      cluesList += `\n`;
    });
  }

  return `⚡️ 🗳️ *VOTING PHASE IS ACTIVE (ROUND ${game.round})* 🗳️ ⚡️\n` +
         `━━━━━━━━━━━━━━━━━━━━━\n\n` +
         `💬 *Players & Clues Submitted:*\n${cluesList}\n` +
         `─────────────────────\n` +
         `Click the button below to vote for the player you suspect is the Imposter!\n\n` +
         `🕰️ *Time Limit*: \`60s\`\n` +
         `👥 *Voted Players (${totalVoted}/${game.players.length}):*\n• _${votedPlayersNames}_`;
}

// Start command - deep linking for joining
bot.start(async (ctx) => {
  const payload = ctx.payload;
  
  if (payload && payload.startsWith('join_')) {
    const targetChatId = Number(payload.substring(5));
    const game = games.get(targetChatId);

    if (!game) {
      return ctx.reply("❌ That game lobby no longer exists or has expired.");
    }

    if (game.status !== 'lobby' && game.status !== 'ended') {
      return ctx.reply("⚠️ This game is currently in progress!");
    }

    const userId = ctx.from.id;

    // Block anonymous admins from joining
    try {
      const member = await ctx.telegram.getChatMember(targetChatId, userId);
      if (member && member.is_anonymous) {
        return ctx.reply("❌ You have 'Remain Anonymous' enabled in this group settings. Please turn it off before joining the game, or you won't be able to submit clues!");
      }
    } catch (err) {
      // Ignore if bot does not have permissions to query chat member
    }

    const name = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
    const username = ctx.from.username ? `@${ctx.from.username}` : '';

    const exists = game.players.some(p => p.id === userId);
    if (exists) {
      return ctx.reply("✅ You are already in the lobby! Go back to the group chat.");
    }

    game.players.push({ id: userId, name, username });
    
    // Initialize score
    if (!game.scores) game.scores = {};
    if (game.scores[userId] === undefined) {
      game.scores[userId] = 0;
    }
    
    await ctx.reply(`✅ Successfully joined the game! Go back to the group.`);
    
    if (game.status === 'lobby') {
      await updateLobbyMessage(targetChatId);
    } else if (game.status === 'ended') {
      await updateResultsMessageKeyboard(targetChatId);
    }
  } else {
    if (!isGroup(ctx)) {
      ctx.reply(
        "👋 Welcome to the Imposter Game Bot!\n\n" +
        "To play, add me to a Telegram group chat and send `/impostergame` to start a lobby!"
      );
    }
  }
});

// Update lobby message helper
async function updateLobbyMessage(chatId) {
  const game = games.get(chatId);
  if (!game || game.status !== 'lobby' || !game.lobbyMessageId) return;

  const playersList = game.players.map((p, i) => `• *${p.name}*`).join('\n') || '_No players yet_';
  await safeTelegramEditMessageText(
    chatId,
    game.lobbyMessageId,
    `✨ 🎮 *IMPOSTER GAME LOBBY* 🎮 ✨\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Join the lobby using the *🙋‍♂️ Join Game* button below!\n\n` +
    `👥 *Joined Players (${game.players.length}):*\n${playersList}\n\n` +
    `⚙️ *Game Settings:*\n` +
    `• Undercover Mode: *${game.undercoverMode ? 'ON 🟢' : 'OFF 🔴'}*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🙋‍♂️ Join Game', 'join_game_click')],
        [
          Markup.button.callback(`⚙️ Undercover: ${game.undercoverMode ? 'ON 🟢' : 'OFF 🔴'}`, 'toggle_undercover'),
          Markup.button.callback('🚀 Start Game', 'start_game')
        ],
        [Markup.button.callback('❌ Cancel Game', 'cancel_game')]
      ])
    }
  );
}

// Update results message keyboard helper
async function updateResultsMessageKeyboard(chatId) {
  const game = games.get(chatId);
  if (!game || game.status !== 'ended' || !game.lobbyMessageId) return;

  const totalPlayers = game.players.length;
  const requiredVotes = Math.ceil(totalPlayers / 2);
  const currentVotes = game.nextRoundVotes.length;

  try {
    await bot.telegram.editMessageReplyMarkup(
      chatId,
      game.lobbyMessageId,
      null,
      Markup.inlineKeyboard([
        [Markup.button.callback('🙋‍♂️ Join Game', 'join_game_click')],
        [Markup.button.callback(`🔄 Start New Match (${currentVotes}/${requiredVotes})`, 'start_new_match')],
        [Markup.button.callback('❌ Close Lobby & Exit', 'cancel_game')]
      ]).reply_markup
    );
  } catch (err) {
    // Ignore
  }
}

// /impostergame command (Groups only)
bot.command('impostergame', async (ctx) => {
  if (!isGroup(ctx)) {
    return ctx.reply("❌ Please run this command in a group chat!");
  }

  const chatId = ctx.chat.id;
  
  if (games.has(chatId)) {
    return ctx.reply("⚠️ A game is already active in this group. Cancel it first to start a new one.");
  }

  const initialMsg = await ctx.reply(
    `✨ 🎮 *IMPOSTER GAME LOBBY* 🎮 ✨\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Join the lobby using the *🙋‍♂️ Join Game* button below!\n\n` +
    `👥 *Joined Players (0):*\n_No players yet_\n\n` +
    `⚙️ *Game Settings:*\n` +
    `• Undercover Mode: *OFF 🔴*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🙋‍♂️ Join Game', 'join_game_click')],
        [
          Markup.button.callback('⚙️ Undercover: OFF 🔴', 'toggle_undercover'),
          Markup.button.callback('🚀 Start Game', 'start_game')
        ],
        [Markup.button.callback('❌ Cancel Game', 'cancel_game')]
      ])
    }
  );

  games.set(chatId, {
    lobbyMessageId: initialMsg.message_id,
    creatorId: ctx.from.id,
    players: [],
    status: 'lobby',
    undercoverMode: false,
    votes: {},
    clues: {},
    speakingOrderList: [],
    currentSpeakerIndex: 0,
    turnInterval: null,
    votingInterval: null,
    cluePromptMessageId: null,
    round: 1,
    history: [],
    nextRoundVotes: [],
    phaseVotes: { anotherRound: [], goVoting: [] },
    cancelVotes: []
  });
});

// /stats command
bot.command('stats', async (ctx) => {
  const replyTo = ctx.message.reply_to_message;
  let targetId = null;
  let targetUsername = null;

  const text = ctx.message.text ? ctx.message.text.trim() : '';
  const args = text.split(/\s+/).slice(1);
  
  if (replyTo) {
    targetId = replyTo.from.id;
  } else if (args.length > 0 && args[0].startsWith('@')) {
    targetUsername = args[0].substring(1).toLowerCase();
  } else {
    targetId = ctx.from.id;
  }

  if (targetId) {
    db.get('SELECT * FROM stats WHERE userId = ?', [targetId], (err, row) => {
      if (err) {
        console.error('Database query error:', err);
        return ctx.reply("❌ Error fetching stats from database.");
      }
      if (!row) {
        const name = replyTo ? (replyTo.from.first_name + (replyTo.from.last_name ? ` ${replyTo.from.last_name}` : '')) : ctx.from.first_name;
        return ctx.reply(`📊 *Stats for ${escapeMarkdown(name)}*:\nNo games played yet!`, { parse_mode: 'Markdown' });
      }
      sendStatsResponse(ctx, row);
    });
  } else if (targetUsername) {
    db.get('SELECT * FROM stats WHERE LOWER(username) = ? OR LOWER(username) = ?', [`@${targetUsername}`, targetUsername], (err, row) => {
      if (err) {
        console.error('Database query error:', err);
        return ctx.reply("❌ Error fetching stats from database.");
      }
      if (!row) {
        return ctx.reply(`❌ No stats found for @${escapeMarkdown(targetUsername)}.`);
      }
      sendStatsResponse(ctx, row);
    });
  }
});

function sendStatsResponse(ctx, row) {
  const usernameText = row.username ? ` (${escapeMarkdown(row.username)})` : '';
  const response = `📊 *PLAYER STATS* 📊\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 *Name*: *${escapeMarkdown(row.name)}*${usernameText}\n` +
    `🆔 *ID*: \`${row.userId}\`\n` +
    `─────────────────────\n` +
    `😈 *Imposter Wins*: \`${row.imposter_wins}\`\n` +
    `😇 *Innocent Wins*: \`${row.innocent_wins}\`\n` +
    `🎯 *Correct Imposter Accusations*: \`${row.correct_votes}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━━`;
  ctx.reply(response, { parse_mode: 'Markdown' });
}

// /cancel command requiring 3 players' votes
bot.command('cancel', async (ctx) => {
  if (!isGroup(ctx)) {
    return ctx.reply("❌ Please run this command in a group chat!");
  }

  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.reply("❌ No active game session in this group.");
  }

  const userId = ctx.from.id;
  const isPlayer = game.players.some(p => p.id === userId);
  
  if (!isPlayer) {
    return ctx.reply("❌ Only players in this game can vote to cancel.");
  }

  if (!game.cancelVotes) {
    game.cancelVotes = [];
  }

  if (game.cancelVotes.includes(userId)) {
    return ctx.reply("ℹ️ You have already voted to cancel the game.");
  }

  game.cancelVotes.push(userId);
  const cancelCount = game.cancelVotes.length;
  const targetVotes = Math.min(3, game.players.length);

  if (cancelCount >= targetVotes) {
    await ctx.reply(`🛑 Cancel threshold reached (${cancelCount}/${targetVotes}). Ending the game...`);
    await executeGameCancellation(chatId, game);
  } else {
    const senderName = ctx.from.first_name;
    await ctx.reply(`⚠️ *${escapeMarkdown(senderName)}* voted to cancel the game (${cancelCount}/${targetVotes} votes recorded). Other players must type /cancel to end the game!`, { parse_mode: 'Markdown' });
  }
});

// Join game action: checks if the player has started the bot first!
// If not, it AUTOMATICALLY triggers a redirect to the bot's private chat.
bot.action('join_game_click', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.answerCbQuery("❌ No active game session.", { show_alert: true });
  }

  if (game.status !== 'lobby' && game.status !== 'ended') {
    return ctx.answerCbQuery("⚠️ The game is currently in progress!", { show_alert: true });
  }

  const userId = ctx.from.id;

  // Block anonymous admins from joining
  try {
    const member = await ctx.telegram.getChatMember(chatId, userId);
    if (member && member.is_anonymous) {
      return ctx.answerCbQuery("❌ Please turn off 'Remain Anonymous' in group settings to join the game!", { show_alert: true });
    }
  } catch (err) {
    // Ignore if we can't query member info
  }

  const name = ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : '');
  const username = ctx.from.username ? `@${ctx.from.username}` : '';

  const exists = game.players.some(p => p.id === userId);
  if (exists) {
    return ctx.answerCbQuery("ℹ️ You have already joined this lobby!");
  }

  // Check if player has started DM
  let botStarted = true;
  try {
    await bot.telegram.sendChatAction(userId, 'typing');
  } catch (err) {
    botStarted = false;
  }

  if (!botStarted) {
    // If not started, AUTOMATICALLY redirect them to the private chat deep-link!
    const botInfo = await bot.telegram.getMe();
    const joinUrl = `https://t.me/${botInfo.username}?start=join_${chatId}`;
    
    // Telegram allows redirecting callback queries directly to t.me/bot URLs!
    return ctx.answerCbQuery(null, { url: joinUrl });
  }

  // If started, add them directly inside the group
  game.players.push({ id: userId, name, username });
  console.log(`[LOBBY] Player "${name}" (ID: ${userId}) joined game in chat ${chatId}`);

  // Initialize score
  if (!game.scores) game.scores = {};
  if (game.scores[userId] === undefined) {
    game.scores[userId] = 0;
  }

  await ctx.answerCbQuery("🎉 You joined the game successfully!");

  if (game.status === 'lobby') {
    await updateLobbyMessage(chatId);
  } else if (game.status === 'ended') {
    await updateResultsMessageKeyboard(chatId);
  }
});

// Toggle undercover mode
bot.action('toggle_undercover', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.answerCbQuery("❌ No active game session.", { show_alert: true });
  }
  if (game.status !== 'lobby') {
    return ctx.answerCbQuery("⚠️ Cannot change settings after the game starts.", { show_alert: true });
  }

  game.undercoverMode = !game.undercoverMode;
  await ctx.answerCbQuery(`Undercover Mode: ${game.undercoverMode ? 'ON' : 'OFF'}`);
  await updateLobbyMessage(chatId);
});

// Start game handler
bot.action('start_game', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.answerCbQuery("❌ No active game session.", { show_alert: true });
  }
  if (game.status !== 'lobby') {
    return ctx.answerCbQuery("⚠️ Game already started.", { show_alert: true });
  }

  const activePlayers = game.players;
  if (activePlayers.length < 3) {
    return ctx.answerCbQuery("⚠️ You need at least 3 players to start!", { show_alert: true });
  }

  game.status = 'playing';
  game.clues = {};

  const wordSetup = getRandomWord();
  const imposterIndex = Math.floor(Math.random() * activePlayers.length);
  const imposter = activePlayers[imposterIndex];
  
  game.imposter = imposter;
  game.wordSetup = wordSetup;
  console.log(`[GAME START] Chat ${chatId} started. Imposter: "${imposter.name}" (ID: ${imposter.id}). Word: "${wordSetup.word}". Imposter Word: "${wordSetup.imposterWord || 'None'}". Undercover: ${game.undercoverMode}`);

  game.speakingOrderList = [...activePlayers].sort(() => Math.random() - 0.5);
  game.currentSpeakerIndex = 0;

  await ctx.answerCbQuery("🚀 Game is starting!");

  const oldLobbyId = game.lobbyMessageId;
  await safeDeleteMessage(chatId, oldLobbyId);

  // Send Persistent Game Board
  game.turnTimeLeft = 60;
  const boardMsg = await ctx.reply(
    renderBoardText(game),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Reveal My Word', 'reveal_word')],
        [Markup.button.callback('❌ End Game', 'cancel_game')]
      ])
    }
  );

  game.lobbyMessageId = boardMsg.message_id;
  await safePinMessage(chatId, boardMsg.message_id);

  await startNextTurn(chatId);
});

// Start turn loop
async function startNextTurn(chatId) {
  const game = games.get(chatId);
  if (!game || game.status !== 'playing') return;

  game.turnTimeLeft = 60;
  const currentSpeaker = game.speakingOrderList[game.currentSpeakerIndex];
  const mention = getMention(currentSpeaker);
  console.log(`[TURN START] Chat ${chatId}: It is now "${currentSpeaker.name}"'s (ID: ${currentSpeaker.id}) turn`);

  // Update game board once at the start of the turn
  await safeTelegramEditMessageText(
    chatId,
    game.lobbyMessageId,
    renderBoardText(game),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Reveal My Word', 'reveal_word')],
        [Markup.button.callback('❌ End Game', 'cancel_game')]
      ])
    }
  );

  // Send clue prompt targeting current speaker
  const prompt = await bot.telegram.sendMessage(
    chatId,
    `✍️ ${mention}, reply to this message directly to submit your clue!`,
    {
      parse_mode: 'Markdown'
    }
  );
  game.cluePromptMessageId = prompt.message_id;

  // Tick timer in memory without spamming the Nginx/Telegram API
  game.turnInterval = setInterval(async () => {
    game.turnTimeLeft--;

    if (game.turnTimeLeft <= 0) {
      clearInterval(game.turnInterval);
      game.turnInterval = null;

      game.clues[currentSpeaker.id] = "Timeout ⏰";
      
      if (game.cluePromptMessageId) {
        await safeDeleteMessage(chatId, game.cluePromptMessageId);
        game.cluePromptMessageId = null;
      }

      game.currentSpeakerIndex++;
      if (game.currentSpeakerIndex >= game.speakingOrderList.length) {
        await askNextPhase(chatId);
      } else {
        await startNextTurn(chatId);
      }
    }
  }, 1000);
}

// Listener for replies to clue prompt
bot.on('message', async (ctx, next) => {
  if (!isGroup(ctx)) return next();
  const chatId = ctx.chat.id;
  const game = games.get(chatId);
  if (!game || game.status !== 'playing') return next();

  const replyTo = ctx.message.reply_to_message;
  const currentSpeaker = game.speakingOrderList[game.currentSpeakerIndex];

  const isReply = replyTo && game.cluePromptMessageId && replyTo.message_id === game.cluePromptMessageId;

  if (isReply) {
    if (ctx.from.id !== currentSpeaker.id) {
      return;
    }

    const clueText = ctx.message.text ? ctx.message.text.trim() : '';
    if (!clueText) return;

    game.clues[ctx.from.id] = clueText;
    console.log(`[CLUE SUBMIT] Chat ${chatId}: "${ctx.from.first_name}" (ID: ${ctx.from.id}) submitted clue: "${clueText}"`);

    game.cluePromptMessageId = null;

    if (game.turnInterval) {
      clearInterval(game.turnInterval);
      game.turnInterval = null;
    }

    game.currentSpeakerIndex++;
    if (game.currentSpeakerIndex >= game.speakingOrderList.length) {
      await askNextPhase(chatId);
    } else {
      await startNextTurn(chatId);
    }
    return;
  }
  return next();
});

// Start voting phase
async function startVotingPhase(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  await safeUnpinMessage(chatId, game.lobbyMessageId);
  await safeDeleteMessage(chatId, game.lobbyMessageId);

  game.status = 'voting';
  game.votes = {};
  game.votingTimeLeft = 60;

  const votingButtons = game.players.map(p => {
    return [Markup.button.callback(`Vote for ${p.name}`, `vote_${p.id}`)];
  });
  votingButtons.push([Markup.button.callback('❌ End Game', 'cancel_game')]);

  const votingMsg = await bot.telegram.sendMessage(
    chatId,
    renderVotingText(game),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(votingButtons)
    }
  );

  game.lobbyMessageId = votingMsg.message_id;
  await safePinMessage(chatId, votingMsg.message_id);

  game.votingInterval = setInterval(async () => {
    game.votingTimeLeft--;

    if (game.votingTimeLeft <= 0) {
      clearInterval(game.votingInterval);
      game.votingInterval = null;
      await cleanUpVoting(chatId);
      await endVoting(chatId);
    }
  }, 1000);
}

async function cleanUpVoting(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  if (game.votingInterval) {
    clearInterval(game.votingInterval);
    game.votingInterval = null;
  }

  await safeUnpinMessage(chatId, game.lobbyMessageId);
}

// Helper to tally votes
async function endVoting(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  const totalPlayers = game.players.length;
  const votesCast = Object.keys(game.votes).length;

  const tally = {};
  Object.values(game.votes).forEach(vid => {
    tally[vid] = (tally[vid] || 0) + 1;
  });

  let maxVotes = 0;
  let votedOutId = null;
  let tie = false;

  Object.entries(tally).forEach(([vid, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      votedOutId = Number(vid);
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  });

  const votedOutPlayer = game.players.find(p => p.id === votedOutId);
  const imposter = game.imposter;
  const wordSetup = game.wordSetup;

  let resultMsg = `⚡️ 🗳️ *GAME RESULTS: ROUND ${game.round}* 🗳️ ⚡️\n`;
  resultMsg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  let imposterWon = false;
  if (votesCast === 0) {
    resultMsg += `🤷‍♂️ *No votes were cast!*\nNobody made a choice.\n\n😈 *IMPOSTER WINS!* 🏆`;
    imposterWon = true;
  } else if (tie) {
    resultMsg += `⚖️ *It's a Tie!*\nThe group couldn't agree on a suspect.\n\n😈 *IMPOSTER WINS!* 🏆`;
    imposterWon = true;
  } else if (votedOutPlayer.id === imposter.id) {
    resultMsg += `🎉 *Success!*\nYou successfully voted out the Imposter: *${escapeMarkdown(votedOutPlayer.name)}*!\n\n🏆 *INNOCENTS WIN!* 🎉`;
  } else {
    resultMsg += `💀 *Oops!*\nYou voted out an Innocent: *${escapeMarkdown(votedOutPlayer.name)}*.\n\n😈 *IMPOSTER WINS!* 🏆`;
    imposterWon = true;
  }

  // Tally and apply points to scores
  if (!game.scores) {
    game.scores = {};
  }
  // Initialize missing scores
  game.players.forEach(p => {
    if (game.scores[p.id] === undefined) {
      game.scores[p.id] = 0;
    }
  });

  if (imposterWon) {
    // Imposter wins: Imposter gets +20, Innocents who voted Imposter get +10
    game.scores[imposter.id] = (game.scores[imposter.id] || 0) + 20;
    game.players.forEach(p => {
      if (p.id !== imposter.id) {
        const playerVote = game.votes[p.id];
        if (playerVote === imposter.id) {
          game.scores[p.id] = (game.scores[p.id] || 0) + 10;
        }
      }
    });
  } else {
    // Innocents win: Imposter gets 0, all Innocents get +15
    game.players.forEach(p => {
      if (p.id !== imposter.id) {
        game.scores[p.id] = (game.scores[p.id] || 0) + 15;
      }
    });
  }

  // Update persistent database statistics
  game.players.forEach(p => {
    const isImp = p.id === imposter.id;
    const won = isImp ? imposterWon : !imposterWon;
    const votedImposter = game.votes[p.id] === imposter.id;

    updatePlayerStats(
      p.id,
      p.name,
      p.username ? p.username : '',
      isImp,
      won,
      votedImposter
    );
  });

  // Show clues from all clue rounds in the final winner message
  let allCluesText = '';
  game.history.forEach((h) => {
    allCluesText += `*Round ${h.round}*:\n`;
    game.players.forEach((player) => {
      const clue = h.clues[player.id] || 'No clue submitted ⏰';
      allCluesText += `• ${escapeMarkdown(player.name)}: _"${escapeMarkdown(clue)}"_\n`;
    });
    allCluesText += `\n`;
  });

  resultMsg += `\n\n💬 *All Clues Submitted:*\n${allCluesText}`;

  // Fix the classic Imposter word bug here by checking game.undercoverMode
  const imposterWordText = game.undercoverMode ? (wordSetup.imposterWord || 'None') : 'None (Classic Mode)';

  resultMsg += `\n\n─────────────────────\n` +
    `🕵️‍♂️ *Imposter*: *${escapeMarkdown(imposter.name)}* (${escapeMarkdown(imposter.username) || 'No username'})\n\n` +
    `🔑 *Innocent Word*: \`${wordSetup.word}\`\n` +
    `🤫 *Imposter Word*: \`${imposterWordText}\`\n` +
    `━━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Scoreboard display
  let scoreboardText = `🏆 *LOBBY SCOREBOARD* 🏆\n`;
  const sortedPlayers = [...game.players].sort((a, b) => (game.scores[b.id] || 0) - (game.scores[a.id] || 0));
  sortedPlayers.forEach(p => {
    scoreboardText += `• *${escapeMarkdown(p.name)}*: \`${game.scores[p.id] || 0} pts\`\n`;
  });

  resultMsg += scoreboardText + `━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 *Start a new match?* (Majority vote required)`;

  game.status = 'ended';
  game.nextRoundVotes = [];

  const requiredVotes = Math.ceil(totalPlayers / 2);

  console.log(`[GAME OVER] Chat ${chatId} ended. Imposter: ${imposter.name}, Word: ${wordSetup.word}. Votes cast: ${votesCast}`);
  
  await safeTelegramEditMessageText(
    chatId,
    game.lobbyMessageId,
    resultMsg,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🙋‍♂️ Join Game', 'join_game_click')],
        [Markup.button.callback(`🔄 Start New Match (0/${requiredVotes})`, 'start_new_match')],
        [Markup.button.callback('❌ Close Lobby & Exit', 'cancel_game')]
      ])
    }
  );
}

// Callback for revealing the word
bot.action('reveal_word', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const game = games.get(chatId);

  if (!game || game.status === 'lobby') {
    return ctx.answerCbQuery("❌ No active game running.", { show_alert: true });
  }

  const player = game.players.find(p => p.id === userId);
  if (!player) {
    return ctx.answerCbQuery("❌ You are not a player in this game lobby!", { show_alert: true });
  }

  const isImposter = userId === game.imposter.id;
  const wordSetup = game.wordSetup;
  let text = '';

  if (isImposter) {
    if (game.undercoverMode && wordSetup.imposterWord) {
      text = `🤫 ROLE: UNDERCOVER IMPOSTER\n\n🔑 Your secret word: ${wordSetup.imposterWord}\n\n⚠️ You are undercover! Blend in!`;
    } else {
      text = `🤫 ROLE: IMPOSTER\n\n🕵️‍♂️ You are the classic Imposter! You do not get a word or category. Blend in!`;
    }
  } else {
    text = `🤫 ROLE: INNOCENT\n📂 Category: ${wordSetup.category}\n🔑 Your secret word: ${wordSetup.word}\n\n🎯 Describe your word without giving it away!`;
  }

  return ctx.answerCbQuery(text, { show_alert: true });
});

// Handle vote action
bot.action(/^vote_(\d+)$/, async (ctx) => {
  const chatId = ctx.chat.id;
  const voterId = ctx.from.id;
  const votedId = Number(ctx.match[1]);
  const game = games.get(chatId);

  if (!game || game.status !== 'voting') {
    return ctx.answerCbQuery("❌ Voting is not active right now.", { show_alert: true });
  }

  const isPlayer = game.players.some(p => p.id === voterId);
  if (!isPlayer) {
    return ctx.answerCbQuery("❌ You are not a player in this game!", { show_alert: true });
  }

  if (voterId === votedId) {
    return ctx.answerCbQuery("❌ You cannot vote for yourself!", { show_alert: true });
  }

  if (game.votes[voterId] === votedId) {
    return ctx.answerCbQuery("ℹ️ You already voted for this player!");
  }

  game.votes[voterId] = votedId;
  const votedPlayer = game.players.find(p => p.id === votedId);
  console.log(`[VOTE CAST] Chat ${chatId}: "${ctx.from.first_name}" (ID: ${voterId}) voted for "${votedPlayer ? votedPlayer.name : votedId}" (ID: ${votedId})`);
  await ctx.answerCbQuery("✅ Vote recorded!");

  const votedPlayersNames = game.players
    .filter(p => game.votes[p.id] !== undefined)
    .map(p => p.name)
    .join(', ');

  const totalVoted = Object.keys(game.votes).length;
  const totalPlayers = game.players.length;

  if (totalVoted >= totalPlayers) {
    await cleanUpVoting(chatId);
    await endVoting(chatId);
  } else {
    const votingButtons = game.players.map(p => {
      return [Markup.button.callback(`Vote for ${p.name}`, `vote_${p.id}`)];
    });
    votingButtons.push([Markup.button.callback('❌ End Game', 'cancel_game')]);

    await safeTelegramEditMessageText(
      chatId,
      game.lobbyMessageId,
      renderVotingText(game),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(votingButtons)
      }
    );
  }
});

// Callback to cancel/end the game
async function executeGameCancellation(chatId, game) {
  if (game.turnInterval) clearInterval(game.turnInterval);
  if (game.votingInterval) clearInterval(game.votingInterval);
  if (game.transitionTimeout) clearTimeout(game.transitionTimeout);

  let revealMessage = "🛑 *Game Cancelled / Ended.*\n";
  revealMessage += "━━━━━━━━━━━━━━━━━━━━━\n";
  if (game.status !== 'lobby' && game.imposter && game.wordSetup) {
    const wordSetup = game.wordSetup;
    const imposterWordText = game.undercoverMode ? (wordSetup.imposterWord || 'None') : 'None (Classic Mode)';
    revealMessage += `🕵️‍♂️ *Imposter*: *${escapeMarkdown(game.imposter.name)}* (${escapeMarkdown(game.imposter.username) || 'No username'})\n\n` +
      `🔑 *Innocent Word*: \`${wordSetup.word}\`\n` +
      `🤫 *Imposter Word*: \`${imposterWordText}\`\n` +
      "━━━━━━━━━━━━━━━━━━━━━";
  }

  await safeUnpinMessage(chatId, game.lobbyMessageId);

  games.delete(chatId);
  await safeTelegramEditMessageText(chatId, game.lobbyMessageId, revealMessage, { parse_mode: 'Markdown' });
}

// Callback to cancel/end the game
bot.action('cancel_game', async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games.get(chatId);

  if (!game) {
    return ctx.answerCbQuery("❌ No active game session.", { show_alert: true });
  }

  const isCreator = ctx.from.id === game.creatorId;
  if (!isCreator) {
    return ctx.answerCbQuery("❌ Only the game creator can end/cancel the game!", { show_alert: true });
  }

  await ctx.answerCbQuery("🛑 Game ended.");
  await executeGameCancellation(chatId, game);
});

// Render transition voting board text showing all clues from all rounds
function renderTransitionText(game) {
  let cluesText = '';
  // Append historical rounds
  game.history.forEach(h => {
    cluesText += `*Round ${h.round}*:\n`;
    game.players.forEach(player => {
      const clue = h.clues[player.id] || 'No clue submitted ⏰';
      cluesText += `• ${escapeMarkdown(player.name)}: _"${escapeMarkdown(clue)}"_\n`;
    });
    cluesText += `\n`;
  });
  
  // Append current round clues
  cluesText += `*Round ${game.round}* (Latest):\n`;
  game.speakingOrderList.forEach(player => {
    const clue = game.clues[player.id] || 'No clue submitted ⏰';
    cluesText += `• ${escapeMarkdown(player.name)}: _"${escapeMarkdown(clue)}"_\n`;
  });

  const anotherRoundCount = game.phaseVotes ? game.phaseVotes.anotherRound.length : 0;
  const goVotingCount = game.phaseVotes ? game.phaseVotes.goVoting.length : 0;
  const totalPlayers = game.players.length;
  const majority = Math.ceil(totalPlayers / 2);

  return `✨ 🎮 *ROUND ${game.round} CLUES COMPLETE* 🎮 ✨\n` +
         `━━━━━━━━━━━━━━━━━━━━━\n\n` +
         `💬 *All Clues Submitted:*\n${cluesText}\n` +
         `─────────────────────\n` +
         `🤔 *What should we do next?*\n` +
         `• If the majority votes for another clue round, players will submit another clue for the same word.\n` +
         `• Otherwise, we will proceed to voting.\n\n` +
         `⏳ *Automatic Transition*: If the majority (${majority}/${totalPlayers}) does not vote, the game will automatically proceed to the voting phase in 60s.\n\n` +
         `📝 *Clue Round Votes*: ${anotherRoundCount}\n` +
         `🗳️ *Voting Phase Votes*: ${goVotingCount}`;
}

// Ask players what they want to do after a clue round is complete
async function askNextPhase(chatId) {
  const game = games.get(chatId);
  if (!game) return;

  if (game.transitionTimeout) {
    clearTimeout(game.transitionTimeout);
    game.transitionTimeout = null;
  }

  game.status = 'transition';
  game.phaseVotes = { anotherRound: [], goVoting: [] };

  const text = renderTransitionText(game);

  // Delete the old clue board message to keep chat clean
  const oldBoardId = game.lobbyMessageId;
  await safeDeleteMessage(chatId, oldBoardId);

  // Send NEW message for transition voting
  const msg = await bot.telegram.sendMessage(
    chatId,
    text,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📝 Another Clue Round (0)', 'phase_vote_clue'),
          Markup.button.callback('🗳️ Go to Voting (0)', 'phase_vote_voting')
        ],
        [Markup.button.callback('❌ End Game', 'cancel_game')]
      ])
    }
  );
  game.lobbyMessageId = msg.message_id;

  // Set a 60-second transition timeout
  game.transitionTimeout = setTimeout(async () => {
    const activeGame = games.get(chatId);
    if (activeGame && activeGame.status === 'transition') {
      game.transitionTimeout = null;
      // Save clues to history
      activeGame.history.push({
        round: activeGame.round,
        clues: { ...activeGame.clues }
      });
      await bot.telegram.sendMessage(chatId, "⏰ Time's up! Proceeding to the Voting Phase automatically.");
      await startVotingPhase(chatId);
    }
  }, 60000);
}

// Handle votes for next phase (Clue round vs Voting phase)
bot.action('phase_vote_clue', async (ctx) => {
  await handlePhaseVote(ctx, 'anotherRound');
});

bot.action('phase_vote_voting', async (ctx) => {
  await handlePhaseVote(ctx, 'goVoting');
});

async function handlePhaseVote(ctx, option) {
  const chatId = ctx.chat.id;
  const voterId = ctx.from.id;
  const game = games.get(chatId);

  if (!game || game.status !== 'transition') {
    return ctx.answerCbQuery("❌ No active transition vote running.", { show_alert: true });
  }

  const isPlayer = game.players.some(p => p.id === voterId);
  if (!isPlayer) {
    return ctx.answerCbQuery("❌ You are not a player in this game!", { show_alert: true });
  }

  // Remove voter from other options if they change their vote
  const otherOption = option === 'anotherRound' ? 'goVoting' : 'anotherRound';
  game.phaseVotes[otherOption] = game.phaseVotes[otherOption].filter(id => id !== voterId);

  // Add voter to selected option if not already there
  if (!game.phaseVotes[option].includes(voterId)) {
    game.phaseVotes[option].push(voterId);
  }

  await ctx.answerCbQuery("✅ Vote registered!");

  const totalPlayers = game.players.length;
  const majority = Math.ceil(totalPlayers / 2);

  const anotherRoundCount = game.phaseVotes.anotherRound.length;
  const goVotingCount = game.phaseVotes.goVoting.length;

  // Check if decision is reached
  if (anotherRoundCount >= majority) {
    if (game.transitionTimeout) {
      clearTimeout(game.transitionTimeout);
      game.transitionTimeout = null;
    }

    // Save this round's clues to history
    game.history.push({
      round: game.round,
      clues: { ...game.clues }
    });

    game.round++;
    game.status = 'playing';
    game.clues = {};
    game.speakingOrderList = [...game.players].sort(() => Math.random() - 0.5);
    game.currentSpeakerIndex = 0;

    console.log(`[ROUND START] Chat ${chatId} started Round ${game.round} of clues.`);

    // Send a message stating another round is starting
    await ctx.reply(`📝 Majority voted for Another Clue Round! Starting Clue Round ${game.round}...`);
    
    // We recreate a fresh board message
    game.turnTimeLeft = 60;
    const boardMsg = await ctx.reply(
      renderBoardText(game),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Reveal My Word', 'reveal_word')],
          [Markup.button.callback('❌ End Game', 'cancel_game')]
        ])
      }
    );
    game.lobbyMessageId = boardMsg.message_id;
    await safePinMessage(chatId, boardMsg.message_id);

    await startNextTurn(chatId);
  } else if (goVotingCount >= majority || (anotherRoundCount + goVotingCount >= totalPlayers)) {
    if (game.transitionTimeout) {
      clearTimeout(game.transitionTimeout);
      game.transitionTimeout = null;
    }

    // Save final clues to history before starting voting phase
    game.history.push({
      round: game.round,
      clues: { ...game.clues }
    });

    await ctx.reply("🗳️ Proceeding to the Voting Phase!");
    await startVotingPhase(chatId);
  } else {
    // Update the inline buttons with counts and show all clue history
    const text = renderTransitionText(game);

    try {
      await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`📝 Another Clue Round (${anotherRoundCount})`, 'phase_vote_clue'),
            Markup.button.callback(`🗳️ Go to Voting (${goVotingCount})`, 'phase_vote_voting')
          ],
          [Markup.button.callback('❌ End Game', 'cancel_game')]
        ])
      });
    } catch (err) {
      // Ignore
    }
  }
}

// Handle start new match action (resets game round to 1 and history, starts new match with same players)
bot.action('start_new_match', async (ctx) => {
  const chatId = ctx.chat.id;
  const voterId = ctx.from.id;
  const game = games.get(chatId);

  if (!game || game.status !== 'ended') {
    return ctx.answerCbQuery("❌ No game is currently waiting to start a new match.", { show_alert: true });
  }

  const isPlayer = game.players.some(p => p.id === voterId);
  if (!isPlayer) {
    return ctx.answerCbQuery("❌ You are not a player in this game lobby!", { show_alert: true });
  }

  if (game.nextRoundVotes.includes(voterId)) {
    return ctx.answerCbQuery("ℹ️ You already voted to start a new match!");
  }

  game.nextRoundVotes.push(voterId);
  const totalPlayers = game.players.length;
  const requiredVotes = Math.ceil(totalPlayers / 2);
  const currentVotes = game.nextRoundVotes.length;

  await ctx.answerCbQuery("✅ Vote recorded!");

  if (currentVotes >= requiredVotes) {
    // Reset to Round 1 and clear history
    game.round = 1;
    game.history = [];
    game.status = 'playing';
    game.clues = {};
    game.votes = {};
    game.nextRoundVotes = [];
    game.phaseVotes = { anotherRound: [], goVoting: [] };
    game.cancelVotes = [];

    const wordSetup = getRandomWord();
    const imposterIndex = Math.floor(Math.random() * totalPlayers);
    const imposter = game.players[imposterIndex];

    game.imposter = imposter;
    game.wordSetup = wordSetup;
    game.speakingOrderList = [...game.players].sort(() => Math.random() - 0.5);
    game.currentSpeakerIndex = 0;

    // Delete old board and send a new one
    const oldBoardId = game.lobbyMessageId;
    await safeDeleteMessage(chatId, oldBoardId);

    console.log(`[NEW MATCH START] Chat ${chatId} started a new match. Imposter: "${imposter.name}" (ID: ${imposter.id}). Word: "${wordSetup.word}".`);

    game.turnTimeLeft = 60;
    const boardMsg = await ctx.reply(
      renderBoardText(game),
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Reveal My Word', 'reveal_word')],
          [Markup.button.callback('❌ End Game', 'cancel_game')]
        ])
      }
    );

    game.lobbyMessageId = boardMsg.message_id;
    await safePinMessage(chatId, boardMsg.message_id);

    await startNextTurn(chatId);
  } else {
    // Update the button with new count
    const votingButtons = [
      [Markup.button.callback('🙋‍♂️ Join Game', 'join_game_click')],
      [Markup.button.callback(`🔄 Start New Match (${currentVotes}/${requiredVotes})`, 'start_new_match')],
      [Markup.button.callback('❌ Close Lobby & Exit', 'cancel_game')]
    ];

    try {
      await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(votingButtons).reply_markup);
    } catch (err) {
      // Ignore
    }
  }
});

bot.launch().then(() => {
  console.log("🚀 Telegram Bot is running successfully with automatic redirection!");
}).catch((err) => {
  console.error("Failed to start Telegram Bot:", err);
});

// Enable graceful stop
process.once('SIGINT', () => {
  games.forEach(g => {
    if (g.turnInterval) clearInterval(g.turnInterval);
    if (g.votingInterval) clearInterval(g.votingInterval);
    if (g.transitionTimeout) clearTimeout(g.transitionTimeout);
  });
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  games.forEach(g => {
    if (g.turnInterval) clearInterval(g.turnInterval);
    if (g.votingInterval) clearInterval(g.votingInterval);
    if (g.transitionTimeout) clearTimeout(g.transitionTimeout);
  });
  bot.stop('SIGTERM');
});
