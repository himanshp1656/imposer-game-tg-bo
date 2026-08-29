# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Hugging Face / general web port exposure
EXPOSE 7860

ENV PORT=7860

# Run the bot application
CMD ["node", "bot.js"]
