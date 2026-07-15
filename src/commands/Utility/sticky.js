import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { setSticky, removeSticky, getStickyConfig } from '../../services/stickyService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('sticky')
        .setDescription('Keep a message pinned to the bottom of a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)

        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Set (or replace) the sticky message for this channel')
                .addStringOption(o => o.setName('message').setDescription('The sticky message content').setRequired(true))
                .addIntegerOption(o =>
                    o.setName('threshold')
                        .setDescription('Repost after this many new messages (default: 5)')
                        .setRequired(false).setMinValue(1).setMaxValue(50)
                )
        )

        .addSubcommand(sub =>
            sub.setName('remove')
                .setDescription('Remove the sticky message from this channel')
        )

        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('List all sticky messages in this server')
        ),

    category: 'utility',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            if (sub === 'set') {
                const content = interaction.options.getString('message');
                const threshold = interaction.options.getInteger('threshold') ?? 5;

                if (content.length > 3900) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('Too Long', 'Sticky message must be under 3900 characters.')],
                        ephemeral: true,
                    });
                }

                await InteractionHelper.safeDefer(interaction, { ephemeral: true });
                await setSticky(client, guildId, interaction.channel, content, threshold);

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed('📌 Sticky Set', `This message will now stay pinned to the bottom of ${interaction.channel}, reposting every **${threshold}** new messages.`)],
                });
            }

            if (sub === 'remove') {
                await InteractionHelper.safeDefer(interaction, { ephemeral: true });
                const removed = await removeSticky(client, guildId, interaction.channel);

                if (!removed) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('No Sticky Found', 'This channel has no active sticky message.')],
                    });
                }

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed('✅ Sticky Removed', 'The sticky message has been removed from this channel.')],
                });
            }

            if (sub === 'list') {
                await InteractionHelper.safeDefer(interaction, { ephemeral: true });
                const config = await getStickyConfig(client, guildId);
                const entries = Object.entries(config.channels);

                if (entries.length === 0) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [createEmbed({ title: '📌 Sticky Messages', description: 'No sticky messages set up yet.', color: 'secondary' })],
                    });
                }

                const lines = entries.map(([channelId, sticky]) =>
                    `<#${channelId}> — every ${sticky.threshold} msgs\n> ${sticky.content.slice(0, 80)}${sticky.content.length > 80 ? '…' : ''}`
                );

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({ title: `📌 Sticky Messages (${entries.length})`, description: lines.join('\n\n'), color: 'primary' })],
                });
            }
        } catch (error) {
            logger.error('Sticky command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'sticky_failed' });
        }
    },
};
