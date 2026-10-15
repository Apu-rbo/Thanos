import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logEvent } from '../../utils/moderation.js';
import { logger } from '../../utils/logger.js';
import { checkRateLimit } from '../../utils/rateLimiter.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { purgeChannel, purgeUserAcrossGuild } from '../../services/purgeService.js';

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export default {
    data: new SlashCommandBuilder()
        .setName('purge-user')
        .setDescription("Delete a user's recent messages (whole server by default)")
        .addUserOption((o) => o.setName('target').setDescription('The user whose messages should be deleted').setRequired(true))
        .addIntegerOption((o) =>
            o
                .setName('hours')
                .setDescription('Server-wide: how many hours back to delete (1-336, default 24)')
                .setMinValue(1)
                .setMaxValue(336),
        )
        .addStringOption((o) =>
            o
                .setName('scope')
                .setDescription('Where to delete (default: entire server, or this channel if you set amount)')
                .addChoices({ name: 'Entire server', value: 'server' }, { name: 'This channel only', value: 'channel' }),
        )
        .addIntegerOption((o) =>
            o
                .setName('amount')
                .setDescription('This channel only: how many of their messages to delete (1-100)')
                .setMinValue(1)
                .setMaxValue(100),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    category: 'moderation',

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('You need the `Manage Messages` permission to purge messages.')],
            });
        }

        const target = interaction.options.getUser('target', true);
        const amount = interaction.options.getInteger('amount');
        const hours = interaction.options.getInteger('hours') ?? 24;
        const scope = interaction.options.getString('scope') ?? (amount ? 'channel' : 'server');

        try {
            const allowed = await checkRateLimit(`purgeuser_${interaction.user.id}`, 5, 60000);
            if (!allowed) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [warningEmbed("You're purging too fast. Please wait a minute and try again.", '⏳ Rate Limited')],
                });
            }

            let summary;
            let deletedTotal;

            if (scope === 'channel') {
                deletedTotal = await purgeChannel(interaction.channel, target.id, {
                    cutoff: Date.now() - TWO_WEEKS_MS,
                    scanLimit: 1000,
                    maxDelete: amount ?? 100,
                });
                summary = `Deleted **${deletedTotal}** message(s) from ${target} in ${interaction.channel}.`;
            } else {
                const result = await purgeUserAcrossGuild(interaction.guild, target.id, { hours });
                deletedTotal = result.deleted;
                summary =
                    `Deleted **${result.deleted}** message(s) from ${target} across **${result.channelsTouched}** channel(s) ` +
                    `(last ${result.lookbackHours}h, scanned ${result.channelsScanned} channels).`;

                if (result.skipped.length > 0) {
                    const shown = result.skipped.slice(0, 5).map((n) => `#${n}`).join(', ');
                    summary += `\n⚠️ Skipped ${result.skipped.length} channel(s) where I lack View/Read History/Manage Messages: ${shown}${result.skipped.length > 5 ? '…' : ''}`;
                }
                if (result.failed.length > 0) {
                    summary += `\n⚠️ Failed on ${result.failed.length} channel(s).`;
                }
            }

            await logEvent({
                client,
                guild: interaction.guild,
                event: {
                    action: scope === 'server' ? 'User Messages Purged (Server-wide)' : 'User Messages Purged',
                    target: `${target.tag} (${target.id})`,
                    executor: `${interaction.user.tag} (${interaction.user.id})`,
                    reason: `Deleted ${deletedTotal} messages (${scope})`,
                    metadata: { userId: target.id, messageCount: deletedTotal, scope, moderatorId: interaction.user.id },
                },
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed(summary, '🗑️ Purge Complete')] });
        } catch (error) {
            logger.error('Purge-user command error:', error);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Something went wrong during the purge. Messages older than 14 days cannot be bulk deleted.')],
            });
        }
    },
};
