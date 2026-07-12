import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { handleLeveling } from '../services/leveling.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
    name: Events.MessageCreate,
    async execute(message, client) {
        try {
            if (message.author.bot || !message.guild) return;
            await handleLeveling(message, client);
        } catch (error) {
            logger.error('Error in messageCreate event:', error);
        }
    }
};
