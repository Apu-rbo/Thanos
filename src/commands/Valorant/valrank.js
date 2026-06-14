import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import {
    linkAccount,
    unlinkAccount,
    getLinkedAccount,
    getAllLinked,
    updateUserRank,
} from '../../services/valRankService.js';

const RANK_EMOJIS = {
    iron: '🩶', bronze: '🥉', silver: '🥈', gold: '🥇',
    platinum: '💎', diamond: '💠', ascendant: '🌿',
    immortal: '👑', radiant: '✨', unranked: '❓',
};

function rankEmoji(tier) {
    const key = tier?.split(' ')[0].toLowerCase();
    return RANK_EMOJIS[key] ?? '❓';
}

export default {
    data: new SlashCommandBuilder()
        .setName('valrank')
        .setDescription('Valorant auto rank role system')

        // /valrank link
        .addSubcommand(sub =>
            sub.setName('link')
                .setDescription('Link your Riot account to get automatic rank roles')
                .addStringOption(o =>
                    o.setName('username').setDescription('Your Riot ID username (e.g. TenZ)').setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('tag').setDescription('Your Riot tag WITHOUT # (e.g. NA1)').setRequired(true)
                )
                .addStringOption(o =>
                    o.setName('region')
                        .setDescription('Your region')
                        .setRequired(true)
                        .addChoices(
                            { name: 'North America', value: 'na' },
                            { name: 'Europe',        value: 'eu' },
                            { name: 'Asia Pacific',  value: 'ap' },
                            { name: 'Korea',         value: 'kr' },
                            { name: 'Latin America', value: 'latam' },
                            { name: 'Brazil',        value: 'br' },
                        )
                )
        )

        // /valrank unlink
        .addSubcommand(sub =>
            sub.setName('unlink')
                .setDescription('Unlink your Riot account and remove rank roles')
        )

        // /valrank check
        .addSubcommand(sub =>
            sub.setName('check')
                .setDescription('Manually refresh your rank role right now')
        )

        // /valrank status
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('See your linked account info')
        )

        // /valrank list (admin)
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('View all linked accounts in this server (Admin only)')
        ),

    async execute(interaction, guildConfig, client) {
        const sub    = interaction.options.getSubcommand();
        const apiKey = process.env.HENRIK_API_KEY;

        if (!apiKey) {
            return InteractionHelper.universalReply(interaction, {
                embeds: [errorEmbed('Not Configured', 'Valorant API key is not set up. Contact the bot owner.')],
                ephemeral: true,
            });
        }

        // ── LINK ──────────────────────────────────────────────────────────────
        if (sub === 'link') {
            await InteractionHelper.safeDefer(interaction, { ephemeral: true });

            const username = interaction.options.getString('username');
            const tag      = interaction.options.getString('tag');
            const region   = interaction.options.getString('region');

            // Verify account exists first
            const res  = await fetch(
                `https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`,
                { headers: { Authorization: apiKey } }
            );
            const data = await res.json();

            if (data.status !== 200) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Account Not Found', `Could not find **${username}#${tag}**. Check your username and tag.`)],
                });
            }

            // Link and immediately assign role
            linkAccount(interaction.guild.id, interaction.user.id, username, tag, region);
            const result = await updateUserRank(client, interaction.guild, interaction.user.id, apiKey);

            if (result.success) {
                const emoji = rankEmoji(result.rank);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(
                        '✅ Account Linked!',
                        `Linked **${username}#${tag}** to your Discord.\n${emoji} Rank role **${result.rank}** assigned!\n\nYour role will auto-update every 30 minutes.`
                    )],
                });
            } else {
                // Linked but role assignment failed (role might not exist)
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({
                        title: '⚠️ Linked but role not assigned',
                        description: `Linked **${username}#${tag}** but couldn't assign role: ${result.reason}\n\nMake sure the rank roles are created in the server!`,
                        color: 'warning',
                    })],
                });
            }
        }

        // ── UNLINK ────────────────────────────────────────────────────────────
        if (sub === 'unlink') {
            await InteractionHelper.safeDefer(interaction, { ephemeral: true });

            const had = unlinkAccount(interaction.guild.id, interaction.user.id);

            if (!had) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Not Linked', "You don't have a linked Valorant account.")],
                });
            }

            // Remove all rank roles
            const member = interaction.member;
            const rankRoleNames = ['Iron','Bronze','Silver','Gold','Platinum','Diamond','Ascendant','Immortal','Radiant','Unranked'];
            const toRemove = member.roles.cache.filter(r =>
                rankRoleNames.some(rn => rn.toLowerCase() === r.name.toLowerCase())
            );
            if (toRemove.size > 0) {
                await member.roles.remove(toRemove, '[ValRank] Account unlinked').catch(() => null);
            }

            return InteractionHelper.safeEditReply(interaction, {
                embeds: [successEmbed('✅ Unlinked', 'Your Valorant account has been unlinked and rank roles removed.')],
            });
        }

        // ── CHECK ─────────────────────────────────────────────────────────────
        if (sub === 'check') {
            await InteractionHelper.safeDefer(interaction, { ephemeral: true });

            const account = getLinkedAccount(interaction.guild.id, interaction.user.id);
            if (!account) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Not Linked', 'Link your account first with `/valrank link`.')],
                });
            }

            const result = await updateUserRank(client, interaction.guild, interaction.user.id, apiKey);

            if (result.success) {
                const emoji = rankEmoji(result.rank);
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [successEmbed(
                        '🔄 Rank Updated!',
                        `${emoji} Your rank role has been updated to **${result.rank}** (${result.rr} RR).`
                    )],
                });
            } else {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Update Failed', result.reason)],
                });
            }
        }

        // ── STATUS ────────────────────────────────────────────────────────────
        if (sub === 'status') {
            await InteractionHelper.safeDefer(interaction, { ephemeral: true });

            const account = getLinkedAccount(interaction.guild.id, interaction.user.id);
            if (!account) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [errorEmbed('Not Linked', 'You have no linked Valorant account. Use `/valrank link` to get started.')],
                });
            }

            const lastUpdated = account.lastUpdated
                ? `<t:${Math.floor(account.lastUpdated / 1000)}:R>`
                : 'Never';
            const emoji = rankEmoji(account.lastRank);

            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: '🎮 Your Valorant Link',
                    color: 'primary',
                    fields: [
                        { name: 'Riot ID',      value: `${account.username}#${account.tag}`, inline: true },
                        { name: 'Region',       value: account.region.toUpperCase(),          inline: true },
                        { name: 'Current Rank', value: `${emoji} ${account.lastRank ?? 'Unknown'}`, inline: true },
                        { name: 'Last Updated', value: lastUpdated, inline: true },
                    ],
                })],
            });
        }

        // ── LIST (Admin) ──────────────────────────────────────────────────────
        if (sub === 'list') {
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return InteractionHelper.universalReply(interaction, {
                    embeds: [errorEmbed('No Permission', 'Only administrators can view all linked accounts.')],
                    ephemeral: true,
                });
            }

            await InteractionHelper.safeDefer(interaction, { ephemeral: true });

            const all = getAllLinked(interaction.guild.id);
            if (all.length === 0) {
                return InteractionHelper.safeEditReply(interaction, {
                    embeds: [createEmbed({
                        title: '📋 Linked Accounts',
                        description: 'No accounts linked yet.',
                        color: 'secondary',
                    })],
                });
            }

            const lines = all.map(([discordId, acc]) => {
                const emoji = rankEmoji(acc.lastRank);
                return `<@${discordId}> → **${acc.username}#${acc.tag}** ${emoji} ${acc.lastRank ?? 'Unknown'} (${acc.region.toUpperCase()})`;
            });

            return InteractionHelper.safeEditReply(interaction, {
                embeds: [createEmbed({
                    title: `📋 Linked Accounts (${all.length})`,
                    description: lines.join('\n'),
                    color: 'primary',
                })],
            });
        }
    },
};
