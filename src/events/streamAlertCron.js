import { Events } from 'discord.js';
import cron from 'node-cron';
import { logger } from '../utils/logger.js';
import { checkAllTwitchStreamers, checkAllYoutubeStreamers } from '../services/streamAlertService.js';

export default {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        // ── Twitch: cheap API, checks every 3 minutes ──
        if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) {
            logger.info('[StreamAlert] Twitch check scheduler started — every 3 minutes.');
            cron.schedule('*/3 * * * *', async () => {
                try {
                    const summary = await checkAllTwitchStreamers(client);
                    if (summary.checked > 0) {
                        logger.info(`[StreamAlert:twitch] Sweep done: checked ${summary.checked}, announced ${summary.announced}, errors ${summary.errors}`);
                    }
                } catch (error) {
                    logger.error('[StreamAlert:twitch] Scheduled check error:', error);
                }
            });
        } else {
            logger.warn('[StreamAlert] TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET not set — Twitch alerts disabled.');
        }

        // ── YouTube: quota-limited API (100 units/check, 10,000/day free),
        // checks every 15 minutes to stay well within the free daily quota. ──
        if (process.env.YOUTUBE_API_KEY) {
            logger.info('[StreamAlert] YouTube check scheduler started — every 15 minutes (quota-limited).');
            cron.schedule('*/15 * * * *', async () => {
                try {
                    const summary = await checkAllYoutubeStreamers(client);
                    if (summary.checked > 0) {
                        logger.info(`[StreamAlert:youtube] Sweep done: checked ${summary.checked}, announced ${summary.announced}, errors ${summary.errors}`);
                    }
                } catch (error) {
                    logger.error('[StreamAlert:youtube] Scheduled check error:', error);
                }
            });
        } else {
            logger.warn('[StreamAlert] YOUTUBE_API_KEY not set — YouTube alerts disabled.');
        }
    },
};
