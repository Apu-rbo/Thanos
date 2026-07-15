import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleStickyRepost } from '../services/stickyService.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        try {
            await handleStickyRepost(message.client, message);
        } catch (error) {
            logger.error('[Sticky] messageCreate handler error:', error);
        }
    },
};
