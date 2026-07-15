import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { handleInteractionError, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import {
    parseRiotId,
    setLogChannel,
    getLogChannel,
    trackAccount,
    untrackAccount,
    updateAccountSettings,
    getTrackedAccounts,
    refreshAccountNow,
    VALORANT_RANK_ROLE_NAMES,
} from '../../services/valorantService.js';

const REGION_CHOICES = [
    { name: 'Europe', value: 'eu' },
    { name: 'North America', value: 'na' },
    { name: 'Asia Pacific', value: 'ap' },
    { name: 'Korea', value: 'kr' },
    { name: 'Latin America', value: 'latam' },
    { name: 'Brazil', value: 'br' },
];

export default {
    data: new SlashCommandBuilder()
        .setName('valorant')
        .setDescription('Track Valorant ranks, match results, and rank roles')
        .addSubcommand(subcommand =>
            subcommand
                .setName('setchannel')
                .setDescription('Set the channel where rank/match updates are posted (admin only)')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to post Valorant updates to')
                        .setRequired(true)
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('track')
                .setDescription('Start tracking a Valorant account')
                .addStringOption(option =>
                    option.setName('riotid')
                        .setDescription('Riot ID in Name#Tag format (e.g. Player#1234)')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option.setName('region')
                        .setDescription('The account\'s region')
                        .setRequired(true)
                        .addChoices(...REGION_CHOICES)
                )
                .addUserOption(option =>
                    option.setName('member')
                        .setDescription('Discord member to receive the rank role (defaults to you)')
                        .setRequired(false)
                )
                .addBooleanOption(option =>
                    option.setName('autorole')
                        .setDescription('Automatically assign a matching rank role? (default: true)')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('untrack')
                .setDescription('Stop tracking a Valorant account')
                .addStringOption(option =>
                    option.setName('riotid')
                        .setDescription('Riot ID in Name#Tag format (e.g. Player#1234)')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('update')
                .setDescription('Change the linked member or auto-role setting for a tracked account')
                .addStringOption(option =>
                    option.setName('riotid')
                        .setDescription('Riot ID in Name#Tag format (e.g. Player#1234)')
                        .setRequired(true)
                        .setAutocomplete(true)
                )
                .addUserOption(option =>
                    option.setName('member')
                        .setDescription('New Discord member to receive the rank role')
                        .setRequired(false)
                )
                .addBooleanOption(option =>
                    option.setName('autorole')
                        .setDescription('Enable or disable automatic rank-role assignment')
                        .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all tracked Valorant accounts in this server')
        ),

    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'setchannel') {
                await handleSetChannel(interaction);
            } else if (subcommand === 'track') {
                await handleTrack(interaction);
            } else if (subcommand === 'untrack') {
                await handleUntrack(interaction);
            } else if (subcommand === 'update') {
                await handleUpdate(interaction);
            } else if (subcommand === 'list') {
                await handleList(interaction);
            }
        } catch (error) {
            await handleInteractionError(interaction, error, {
                type: 'command',
                commandName: 'valorant',
                subcommand,
            });
        }
    },

    async autocomplete(interaction) {
        if (interaction.commandName !== 'valorant') return;
        if (!['untrack', 'update'].includes(interaction.options.getSubcommand())) return;

        try {
            const accounts = await getTrackedAccounts(interaction.client, interaction.guild.id);
            const focused = interaction.options.getFocused().toLowerCase();

            const choices = accounts
                .filter(a => `${a.riotName}#${a.riotTag}`.toLowerCase().includes(focused))
                .slice(0, 25)
                .map(a => ({
                    name: `${a.riotName}#${a.riotTag} (${a.region.toUpperCase()})`,
                    value: `${a.riotName}#${a.riotTag}`,
                }));

            await interaction.respond(choices).catch(() => {});
        } catch (error) {
            await interaction.respond([]).catch(() => {});
        }
    },
};

// ─── Set Log Channel ────────────────────────────────────────────────────────

async function handleSetChannel(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        throw createError(
            'Missing ManageGuild permission for /valorant setchannel',
            ErrorTypes.PERMISSION,
            'You need the "Manage Server" permission to set the Valorant update channel.',
            {}
        );
    }

    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
    if (!deferSuccess) return;

    const channel = interaction.options.getChannel('channel');

    if (!channel.permissionsFor(interaction.guild.members.me).has(PermissionFlagsBits.SendMessages)) {
        throw createError(
            `Bot cannot send messages in ${channel.name}`,
            ErrorTypes.PERMISSION,
            `I don't have permission to send messages in ${channel}.`,
            { channelId: channel.id }
        );
    }

    await setLogChannel(interaction.client, interaction.guildId, channel.id);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('✅ Channel Set', `Valorant rank/match updates will now be posted in ${channel}.`)],
    });
}

// ─── Track ──────────────────────────────────────────────────────────────────

async function handleTrack(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
    if (!deferSuccess) return;

    const riotIdRaw = interaction.options.getString('riotid');
    const region = interaction.options.getString('region');
    const targetUser = interaction.options.getUser('member') ?? interaction.user;
    const autoRole = interaction.options.getBoolean('autorole');

    // Linking someone else's Discord account to a rank role requires elevated permission
    if (targetUser.id !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw createError(
            'Missing ManageRoles permission to link another member',
            ErrorTypes.PERMISSION,
            'You need the "Manage Roles" permission to link a Valorant account to someone else.',
            {}
        );
    }

    const parsed = parseRiotId(riotIdRaw);
    if (!parsed) {
        throw createError(
            `Invalid Riot ID format: ${riotIdRaw}`,
            ErrorTypes.VALIDATION,
            `"${riotIdRaw}" doesn't look like a valid Riot ID. Use the format **Name#Tag** (e.g. Player#1234).`,
            { riotIdRaw }
        );
    }

    const logChannelId = await getLogChannel(interaction.client, interaction.guildId);
    if (!logChannelId) {
        throw createError(
            'No Valorant log channel configured',
            ErrorTypes.VALIDATION,
            'No update channel has been set yet. Ask an admin to run `/valorant setchannel` first.',
            {}
        );
    }

    const record = await trackAccount(
        interaction.client,
        interaction.guildId,
        parsed.name,
        parsed.tag,
        region,
        interaction.user.id,
        interaction.user.tag,
        {
            linkedDiscordId: targetUser.id,
            autoRole: autoRole ?? true,
        }
    );

    logger.info(`${interaction.user.tag} started tracking Valorant account ${parsed.name}#${parsed.tag} in guild ${interaction.guild.name}`);

    // Instantly check rank + assign role right now, instead of waiting for the next cron sweep.
    const { mmr, roleResult } = await refreshAccountNow(interaction.client, interaction.guild, record);

    let statusLines = [];

    if (mmr) {
        statusLines.push(`🎯 Current rank: **${mmr.tierName}** (${mmr.rr} RR)`);
    } else {
        statusLines.push('⚠️ Could not fetch a current rank yet — this account may have no ranked games this act. Roles/updates will keep retrying automatically.');
    }

    if (record.autoRole) {
        if (roleResult?.success) {
            statusLines.push(`🏷️ Role assigned: **${roleResult.roleName}** → ${targetUser}`);
        } else if (roleResult) {
            statusLines.push(`⚠️ Role not assigned: ${roleResult.reason}`);
        } else if (mmr) {
            statusLines.push(`⚠️ Role not assigned — could not find ${targetUser} in this server.`);
        }
    } else {
        statusLines.push(`🏷️ Auto-role is off for this account. Roles named ${VALORANT_RANK_ROLE_NAMES.slice(0, 3).join(', ')}, etc. must exist to use it.`);
    }

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [
            successEmbed(
                '✅ Now Tracking',
                `**${record.riotName}#${record.riotTag}** (${region.toUpperCase()}) is now being tracked.\n\n${statusLines.join('\n')}\n\nOngoing updates will be posted to <#${logChannelId}> every ~15 minutes.`
            ),
        ],
    });
}

// ─── Untrack ────────────────────────────────────────────────────────────────

async function handleUntrack(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
    if (!deferSuccess) return;

    const riotIdRaw = interaction.options.getString('riotid');
    const parsed = parseRiotId(riotIdRaw);
    if (!parsed) {
        throw createError(
            `Invalid Riot ID format: ${riotIdRaw}`,
            ErrorTypes.VALIDATION,
            `"${riotIdRaw}" doesn't look like a valid Riot ID. Use the format **Name#Tag** (e.g. Player#1234).`,
            { riotIdRaw }
        );
    }

    await untrackAccount(interaction.client, interaction.guildId, parsed.name, parsed.tag);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('✅ Untracked', `**${parsed.name}#${parsed.tag}** is no longer being tracked.`)],
    });
}

// ─── Update Settings ────────────────────────────────────────────────────────

async function handleUpdate(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
    if (!deferSuccess) return;

    const riotIdRaw = interaction.options.getString('riotid');
    const targetUser = interaction.options.getUser('member');
    const autoRole = interaction.options.getBoolean('autorole');

    if (targetUser && !interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw createError(
            'Missing ManageRoles permission to relink another member',
            ErrorTypes.PERMISSION,
            'You need the "Manage Roles" permission to link a Valorant account to someone else.',
            {}
        );
    }

    if (targetUser === undefined && autoRole === null) {
        throw createError(
            'No update fields provided',
            ErrorTypes.VALIDATION,
            'Provide at least `member` or `autorole` to update.',
            {}
        );
    }

    const parsed = parseRiotId(riotIdRaw);
    if (!parsed) {
        throw createError(
            `Invalid Riot ID format: ${riotIdRaw}`,
            ErrorTypes.VALIDATION,
            `"${riotIdRaw}" doesn't look like a valid Riot ID. Use the format **Name#Tag** (e.g. Player#1234).`,
            { riotIdRaw }
        );
    }

    const updates = {};
    if (targetUser) updates.linkedDiscordId = targetUser.id;
    if (autoRole !== null) updates.autoRole = autoRole;

    await updateAccountSettings(interaction.client, interaction.guildId, parsed.name, parsed.tag, updates);

    await InteractionHelper.safeEditReply(interaction, {
        embeds: [successEmbed('✅ Updated', `Settings for **${parsed.name}#${parsed.tag}** have been updated.`)],
    });
}

// ─── List ───────────────────────────────────────────────────────────────────

async function handleList(interaction) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: ['Ephemeral'] });
    if (!deferSuccess) return;

    const accounts = await getTrackedAccounts(interaction.client, interaction.guildId);

    if (!accounts.length) {
        return await InteractionHelper.safeEditReply(interaction, {
            embeds: [errorEmbed('No Tracked Accounts', 'No Valorant accounts are being tracked yet. Use `/valorant track` to add one.')],
        });
    }

    const logChannelId = await getLogChannel(interaction.client, interaction.guildId);

    const embed = new EmbedBuilder()
        .setTitle('🎯 Tracked Valorant Accounts')
        .setColor(getColor('info'))
        .setDescription(
            accounts
                .map(a => {
                    const rankText = a.lastTierName ? `${a.lastTierName} (${a.lastRR} RR)` : 'Not checked yet';
                    const roleText = a.autoRole ? `🏷️ role → <@${a.linkedDiscordId}>` : '🏷️ role off';
                    return `**${a.riotName}#${a.riotTag}** — ${a.region.toUpperCase()}\n${rankText} • ${roleText}`;
                })
                .join('\n\n')
        )
        .setFooter({
            text: logChannelId
                ? 'Updates + role checks run automatically every ~15 minutes'
                : '⚠️ No update channel set — run /valorant setchannel',
        });

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
}
