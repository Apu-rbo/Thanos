import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    getScamGuardConfig,
    saveScamGuardConfig,
    hashAttachment,
    matchesKnownHash,
    MAX_HASHES,
} from '../../services/scamGuardService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('scamguard')
        .setDescription('Auto-ban hacked accounts that spam scam images (MrBeast / trading scams)')
        .addSubcommand((sub) => sub.setName('status').setDescription('Show Scam Guard settings'))
        .addSubcommand((sub) =>
            sub
                .setName('toggle')
                .setDescription('Turn Scam Guard on or off')
                .addBooleanOption((o) => o.setName('enabled').setDescription('Enable Scam Guard?').setRequired(true)),
        )
        .addSubcommand((sub) =>
            sub
                .setName('addimage')
                .setDescription('Teach Scam Guard a scam image: anyone posting it gets banned instantly')
                .addAttachmentOption((o) => o.setName('image').setDescription('A copy of the scam image').setRequired(true)),
        )
        .addSubcommand((sub) => sub.setName('clearimages').setDescription('Remove all saved scam images'))
        .addSubcommand((sub) =>
            sub
                .setName('threshold')
                .setDescription('How many channels a suspicious image+link/ping must hit before a ban')
                .addIntegerOption((o) =>
                    o.setName('channels').setDescription('Channels (2-6, default 3)').setRequired(true).setMinValue(2).setMaxValue(6),
                ),
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    category: 'moderation',

    async execute(interaction, config, client) {
        const deferred = await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });
        if (!deferred) return;

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('You need the `Manage Server` permission to configure Scam Guard.')],
            });
        }

        const guildId = interaction.guildId;
        const sub = interaction.options.getSubcommand();

        try {
            const cfg = { ...(await getScamGuardConfig(client, guildId)) };

            if (sub === 'status') {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        infoEmbed(
                            `**Status:** ${cfg.enabled ? '✅ Enabled' : '❌ Disabled'}\n` +
                                `**Saved scam images:** ${cfg.hashes.length}/${MAX_HASHES}\n` +
                                `**Pattern rule:** image + link/@everyone in **${cfg.channelThreshold}** channels within **${cfg.windowSeconds}s** → ban\n` +
                                `**Image rule:** posting a saved scam image → instant ban\n\n` +
                                `Staff (Admin / Manage Server / Manage Messages / Ban Members) are exempt from the pattern rule.`,
                            '🛡️ Scam Guard',
                        ),
                    ],
                });
            }

            if (sub === 'toggle') {
                cfg.enabled = interaction.options.getBoolean('enabled', true);
                await saveScamGuardConfig(client, guildId, cfg);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(cfg.enabled ? 'Scam Guard is now **enabled**.' : 'Scam Guard is now **disabled**.')],
                });
            }

            if (sub === 'threshold') {
                cfg.channelThreshold = interaction.options.getInteger('channels', true);
                await saveScamGuardConfig(client, guildId, cfg);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(`Pattern rule now triggers at **${cfg.channelThreshold}** channels.`)],
                });
            }

            if (sub === 'clearimages') {
                cfg.hashes = [];
                await saveScamGuardConfig(client, guildId, cfg);
                return InteractionHelper.safeEditReply(interaction, { embeds: [successEmbed('All saved scam images were removed.')] });
            }

            if (sub === 'addimage') {
                const attachment = interaction.options.getAttachment('image', true);
                const hash = await hashAttachment(attachment);

                if (!hash) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('I could not read that file. Use a PNG, JPG, WEBP or GIF under 8 MB.')],
                    });
                }

                if (matchesKnownHash(hash, cfg.hashes, 3)) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [infoEmbed('That image (or a near-identical one) is already saved.')],
                    });
                }

                if (cfg.hashes.length >= MAX_HASHES) {
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed(`You already saved ${MAX_HASHES} images. Use \`/scamguard clearimages\` first.`)],
                    });
                }

                cfg.hashes.push(hash);
                await saveScamGuardConfig(client, guildId, cfg);

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [
                        successEmbed(
                            `Saved. Anyone posting this image (even resized or re-compressed) will be banned.\n` +
                                `Saved images: **${cfg.hashes.length}/${MAX_HASHES}**. Tip: add each new scam variant you see.`,
                        ),
                    ],
                });
            }
        } catch (error) {
            logger.error('[ScamGuard] Command error:', error);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [errorEmbed('Something went wrong while updating Scam Guard. Please try again.')],
            });
        }
    },
};
