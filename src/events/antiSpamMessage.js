import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { handleAntiSpam } from '../services/antiSpamService.js';

export default {
    name: Events.MessageCreate,
    async execute(message) {
        // TEMPORARY DEBUG LOG — remove once antispam is confirmed working
        logger.info(`[AntiSpam-DEBUG] Message received from ${message.author?.tag ?? 'unknown'} in guild ${message.guild?.id ?? 'DM'}`);

        try {
            const result = await handleAntiSpam(message.client, message);
            logger.info(`[AntiSpam-DEBUG] handleAntiSpam returned: ${result}`);
        } catch (error) {
            logger.error('[AntiSpam] messageCreate handler error:', error);
        }
    },
};
