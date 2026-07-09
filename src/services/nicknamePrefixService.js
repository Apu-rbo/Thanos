import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import {
    getPrefixConfig,
    savePrefixConfig,
    syncMemberNickname,
    syncAllMembers,
} from '../../services/nicknamePrefixService.js';

export default {
    data: new SlashCommandBuilder()
        .setName('nickprefix')
        .setDescription('Set up automatic or manual nickname prefixes')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)

        // /nickprefix setup
        .addSubcommand(sub =>
            sub.setName('setup')
                .setDescription('Enable or disable the nickname prefix system')
                .addBooleanOption(o =>
                    o.setName('enabled').setDescription('Turn the system on or off').setRequired(true)
                )
        )

        // /nickprefix role
        .addSubcommand(sub =>
            sub.setName('role')
                .setDescription('Map a role to an automatic nickname prefix')
                .addRoleOption(o =>
                    o.setName('role').setDescription('The role to map').setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('prefix')
                        .setDescription('Prefix to apply, e.g. [VIP] or [Gold]')
                        .setRequired(true)
                        .setMaxLength(16)
                )
        )

        // /nickprefix unrole
        .addSubcommand(sub =>
            sub.setName('unrole')
                .setDescription('Remove a role prefix mapping')
                .addRoleOption(o =>
                    o.setName('role').setDescription('The role to unmap').setRequired(true)
                )
        )

        // /nickprefix set
        .addSubcommand(sub =>
            sub.setName('set')
                .setDescription('Manually set a nickname prefix for a specific member')
                .addUserOption(o =>
                    o.setName('member').setDescription('The member to set a prefix for').setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('prefix')
                        .setDescription('Prefix to apply, e.g. [Owner]')
                        .setRequired(true)
                        .setMaxLength(16)
                )
        )

        // /nickprefix unset
        .addSubcommand(sub =>
            sub.setName('unset')
                .setDescription('Remove a manually set prefix from a member')
                .addUserOption(o =>
                    o.setName('member').setDescription('The member to remove the prefix from').setRequired(true)
                )
        )

        // /nickprefix list
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('View all configured nickname prefixes')
        )

        // /nickprefix sync
        .addSubcommand(sub =>
            sub.setName('sync')
                .setDescription('Re-apply prefixes to every member right now')
        ),

    category: 'utility',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;

        try {
            // ── SETUP ─────────────────────────────────────────────────────────
            if (sub === 'setup') {
                const enabled = interaction.options.getBoolean('enabled');
                const config = await getPrefixConfig(client, guildId);
                config.enabled = enabled;
                await savePrefixConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        enabled ? '✅ Nickname Prefixes Enabled' : '⏸️ Nickname Prefixes Disabled',
                        enabled
                            ? 'Role-based automatic prefixes are now active. Manual prefixes always work regardless of this setting.'
                            : 'Automatic role-based prefixes are paused. Manually set prefixes will still apply.'
                    )],
                });
            }

            // ── ROLE MAPPING ──────────────────────────────────────────────────
            if (sub === 'role') {
                const role   = interaction.options.getRole('role');
                const prefix = interaction.options.getString('prefix').trim();

                const config = await getPrefixConfig(client, guildId);
                config.rolePrefixes[role.id] = prefix;
                await savePrefixConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        '✅ Role Prefix Mapped',
                        `Members with ${role} will now get the prefix **${prefix}**.\n\nRun \`/nickprefix sync\` to apply this to existing members.`
                    )],
                });
            }

            // ── UNROLE MAPPING ────────────────────────────────────────────────
            if (sub === 'unrole') {
                const role = interaction.options.getRole('role');
                const config = await getPrefixConfig(client, guildId);

                if (!config.rolePrefixes[role.id]) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('Not Mapped', `${role} doesn't have a prefix mapping.`)],
                    });
                }

                delete config.rolePrefixes[role.id];
                await savePrefixConfig(client, guildId, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('✅ Mapping Removed', `Removed the prefix mapping for ${role}.\n\nRun \`/nickprefix sync\` to update existing members.`)],
                });
            }

            // ── MANUAL SET ────────────────────────────────────────────────────
            if (sub === 'set') {
                const member = interaction.options.getMember('member');
                const prefix = interaction.options.getString('prefix').trim();

                if (!member) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('Member Not Found', 'Could not find that member in this server.')],
                    });
                }

                const config = await getPrefixConfig(client, guildId);
                config.manualPrefixes[member.id] = prefix;
                await savePrefixConfig(client, guildId, config);

                const result = await syncMemberNickname(client, member, config);

                if (result.success) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [successEmbed('✅ Prefix Set', `${member} now has the prefix **${prefix}**.`)],
                    });
                } else {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [createEmbed({
                            title: '⚠️ Saved but not applied',
                            description: `Prefix saved, but couldn't update the nickname right now: ${result.reason}`,
                            color: 'warning',
                        })],
                    });
                }
            }

            // ── MANUAL UNSET ──────────────────────────────────────────────────
            if (sub === 'unset') {
                const member = interaction.options.getMember('member');
                const config = await getPrefixConfig(client, guildId);

                if (!member || !config.manualPrefixes[member.id]) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('No Manual Prefix', "That member doesn't have a manually set prefix.")],
                    });
                }

                delete config.manualPrefixes[member.id];
                await savePrefixConfig(client, guildId, config);

                const result = await syncMemberNickname(client, member, config);

                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed(
                        '✅ Manual Prefix Removed',
                        `${member}'s manual prefix has been removed.${!result.success ? `\n⚠️ Nickname update failed: ${result.reason}` : ''}`
                    )],
                });
            }

            // ── LIST ──────────────────────────────────────────────────────────
            if (sub === 'list') {
                const config = await getPrefixConfig(client, guildId);

                const roleLines = Object.entries(config.rolePrefixes).map(
                    ([roleId, prefix]) => `<@&${roleId}> → **${prefix}**`
                );
                const manualLines = Object.entries(config.manualPrefixes).map(
                    ([userId, prefix]) => `<@${userId}> → **${prefix}**`
                );

                return InteractionHelper.universalReply(interaction, {
                    embeds: [createEmbed({
                        title: '📋 Nickname Prefix Configuration',
                        color: 'primary',
                        fields: [
                            { name: 'Status', value: config.enabled ? '✅ Enabled' : '⏸️ Disabled', inline: false },
                            { name: `🎭 Role Prefixes (${roleLines.length})`, value: roleLines.length ? roleLines.join('\n') : 'None configured', inline: false },
                            { name: `👤 Manual Prefixes (${manualLines.length})`, value: manualLines.length ? manualLines.join('\n') : 'None configured', inline: false },
                        ],
                    })],
                });
            }

            // ── SYNC ──────────────────────────────────────────────────────────
            if (sub === 'sync') {
                await InteractionHelper.safeDefer(interaction);

                const config = await getPrefixConfig(client, guildId);
                const { updated, failed, skipped } = await syncAllMembers(client, interaction.guild, config);

                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(
                        '🔄 Sync Complete',
                        `**${updated}** nicknames updated\n**${skipped}** already correct\n**${failed}** failed (likely role hierarchy issues)`
                    )],
                });
            }
        } catch (error) {
            logger.error('NickPrefix command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'nickprefix_failed' });
        }
    },
};
