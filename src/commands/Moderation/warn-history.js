import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } from 'discord.js';
import { createEmbed, errorEmbed, infoEmbed } from '../../utils/embeds.js';
import { getColor } from '../../config/bot.js';
import { WarningService } from '../../services/warningService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const WARNINGS_PER_PAGE = 5;

export default {
    data: new SlashCommandBuilder()
        .setName("warn-history")
        .setDescription("View a paginated history of all warnings for a user")
        .addUserOption((option) =>
            option
                .setName("target")
                .setDescription("User to view warning history for")
                .setRequired(true),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    category: "moderation",

    async execute(interaction, config, client) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Warn-history interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'warn-history'
            });
            return;
        }

        try {
            const target = interaction.options.getUser("target");
            const guildId = interaction.guildId;

            const warnings = await WarningService.getWarnings(guildId, target.id);

            if (warnings.length === 0) {
                return await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        infoEmbed(
                            `Warning History: ${target.tag}`,
                            "✅ This user has no recorded warnings.",
                        ),
                    ],
                });
            }

            const sorted = [...warnings].sort((a, b) => b.timestamp - a.timestamp);
            const totalPages = Math.ceil(sorted.length / WARNINGS_PER_PAGE);
            let currentPage = 1;

            const createHistoryEmbed = (page) => {
                const startIndex = (page - 1) * WARNINGS_PER_PAGE;
                const pageWarnings = sorted.slice(startIndex, startIndex + WARNINGS_PER_PAGE);

                const embed = createEmbed(
                    `📜 Warning History: ${target.tag}`,
                    `Total Warnings: **${sorted.length}**\n**Page ${page} of ${totalPages}**`,
                ).setColor(getColor('warning'));

                pageWarnings.forEach((w, i) => {
                    const overallIndex = startIndex + i + 1;
                    const discordTimestamp = Math.floor(w.timestamp / 1000);
                    embed.addFields({
                        name: `#${overallIndex} • <t:${discordTimestamp}:d> (<t:${discordTimestamp}:R>)`,
                        value: `**Reason:** ${w.reason || "No reason provided"}\n**Moderator:** <@${w.moderatorId}>`,
                        inline: false,
                    });
                });

                embed.setFooter({ text: `User ID: ${target.id}` });

                return embed;
            };

            const createNavigationRow = (page) => {
                return new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId('warnhist_prev')
                        .setLabel('⬅️ Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === 1),
                    new ButtonBuilder()
                        .setCustomId('warnhist_page')
                        .setLabel(`Page ${page}/${totalPages}`)
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('warnhist_next')
                        .setLabel('Next ➡️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(page === totalPages),
                );
            };

            const message = await interaction.editReply({
                embeds: [createHistoryEmbed(currentPage)],
                components: totalPages > 1 ? [createNavigationRow(currentPage)] : [],
            });

            if (totalPages <= 1 || !message) return;

            const collector = message.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 120000,
            });

            collector.on('collect', async (buttonInteraction) => {
                if (buttonInteraction.user.id !== interaction.user.id) {
                    await buttonInteraction.reply({
                        content: 'You cannot use these buttons. Run `/warn-history` to get your own view.',
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }

                await buttonInteraction.deferUpdate();

                if (buttonInteraction.customId === 'warnhist_prev' && currentPage > 1) {
                    currentPage--;
                } else if (buttonInteraction.customId === 'warnhist_next' && currentPage < totalPages) {
                    currentPage++;
                }

                await buttonInteraction.editReply({
                    embeds: [createHistoryEmbed(currentPage)],
                    components: [createNavigationRow(currentPage)],
                });
            });

            collector.on('end', async () => {
                const disabledRow = createNavigationRow(currentPage);
                disabledRow.components.forEach((button) => button.setDisabled(true));

                try {
                    await message.edit({ components: [disabledRow] });
                } catch (error) {
                }
            });
        } catch (error) {
            logger.error('Warn-history command error:', error);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    errorEmbed(
                        "An unexpected error occurred while retrieving warning history. Please try again later.",
                    ),
                ],
            });
        }
    },
};
