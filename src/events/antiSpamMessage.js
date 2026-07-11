import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleAntiSpam } from '../services/antiSpamService.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        try {
            await handleAntiSpam(message.client, message);
        } catch (error) {
            logger.error('[AntiSpam] messageCreate handler error:', error);
        }
    },
};
