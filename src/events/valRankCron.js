import { Events } from 'discord.js';
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { autoUpdateAllRanks } from '../services/valRankService.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        const apiKey = process.env.HENRIK_API_KEY;
        if (!apiKey) {
            logger.warn('[ValRank] HENRIK_API_KEY not set — auto rank updater disabled.');
            return;
        }

        logger.info('[ValRank] Auto rank updater started — runs every 30 minutes.');

        // Run every 30 minutes
        cron.schedule('*/30 * * * *', async () => {
            try {
                logger.info('[ValRank] Running scheduled rank update...');
                const { updated, failed } = await autoUpdateAllRanks(client, apiKey);
                logger.info(`[ValRank] Scheduled update done: ${updated} updated, ${failed} failed.`);
            } catch (err) {
                logger.error('[ValRank] Scheduled rank update error:', err);
            }
        });
    },
};
