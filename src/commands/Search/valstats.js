import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

const RANK_EMOJIS = {
    'Iron': '🩶', 'Bronze': '🥉', 'Silver': '🥈', 'Gold': '🥇',
    'Platinum': '💎', 'Diamond': '💠', 'Ascendant': '🌿',
    'Immortal': '👑', 'Radiant': '✨', 'Unranked': '❓',
};

function getRankEmoji(tier) {
    for (const [key, emoji] of Object.entries(RANK_EMOJIS)) {
        if (tier?.toLowerCase().includes(key.toLowerCase())) return emoji;
    }
    return '❓';
}

function getWinrateColor(winrate) {
    if (winrate >= 55) return 0x00FF7F;
    if (winrate >= 50) return 0xFFD700;
    if (winrate >= 45) return 0xFF8C00;
    return 0xFF4444;
}

export default {
    data: new SlashCommandBuilder()
        .setName('valstats')
        .setDescription('Look up Valorant stats for a player')
        .addStringOption(option =>
            option.setName('username').setDescription('Riot ID username (e.g. TenZ)').setRequired(true)
        )
        .addStringOption(option =>
            option.setName('tag').setDescription('Riot tag WITHOUT # (e.g. NA1)').setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('region')
                .setDescription('Player region (default: eu)')
                .setRequired(false)
                .addChoices(
                    { name: 'North America', value: 'na' },
                    { name: 'Europe', value: 'eu' },
                    { name: 'Asia Pacific', value: 'ap' },
                    { name: 'Korea', value: 'kr' },
                    { name: 'Latin America', value: 'latam' },
                    { name: 'Brazil', value: 'br' },
                )
        ),

    async execute(interaction) {
        await interaction.deferReply();

        const username = interaction.options.getString('username');
        const tag      = interaction.options.getString('tag');
        const region   = interaction.options.getString('region') ?? 'eu';
        const apiKey   = process.env.HENRIK_API_KEY;

        if (!apiKey) {
            return interaction.editReply('❌ Valorant stats are not configured yet. Ask the server admin to set up the API key.');
        }

        const headers = { 'Authorization': apiKey };

        try {
            // ── Step 1: Get account info (v1 is simpler and more reliable) ──
            const accountRes = await fetch(
                `https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`,
                { headers }
            );
            const accountData = await accountRes.json();

            if (accountData.status !== 200) {
                const reason = accountData.errors?.[0]?.message || accountData.message || 'Player not found.';
                return interaction.editReply(`❌ Could not find player **${username}#${tag}**: ${reason}`);
            }

            const accountLevel = accountData.data?.account_level ?? 'N/A';
            const card         = accountData.data?.card?.small ?? null;
            const puuid        = accountData.data?.puuid ?? null;

            // ── Step 2: Get MMR using v2 (most stable) ──
            const mmrRes = await fetch(
                `https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`,
                { headers }
            );
            const mmrData = await mmrRes.json();

            let currentRank = 'Unranked';
            let rr = 0;
            let mmrChangeStr = '+0';
            let peakRank = 'N/A';

            if (mmrData.status === 200) {
                const current = mmrData.data?.current_data;
                currentRank   = current?.currenttierpatched ?? 'Unranked';
                rr            = current?.ranking_in_tier ?? 0;
                const mmrChange = current?.mmr_change_to_last_game ?? 0;
                mmrChangeStr  = mmrChange > 0 ? `+${mmrChange}` : `${mmrChange}`;
                peakRank      = mmrData.data?.highest_rank?.patched_tier ?? 'N/A';
            }

            const rankEmoji = getRankEmoji(currentRank);
            const peakEmoji = getRankEmoji(peakRank);

            // ── Step 3: Get last 5 competitive matches ──
            let matchSummary = 'No recent competitive matches found.';
            let wins = 0, losses = 0;
            let totalKills = 0, totalDeaths = 0;

            const matchRes = await fetch(
                `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}?mode=competitive&size=5`,
                { headers }
            );
            const matchData = await matchRes.json();

            if (matchData.status === 200 && matchData.data?.length > 0) {
                const matches = matchData.data;
                for (const match of matches) {
                    const player = match.players?.all_players?.find(
                        p => p.name.toLowerCase() === username.toLowerCase() &&
                             p.tag.toLowerCase() === tag.toLowerCase()
                    );
                    if (!player) continue;
                    totalKills  += player.stats?.kills  ?? 0;
                    totalDeaths += player.stats?.deaths ?? 0;
                    const team    = player.team?.toLowerCase();
                    const won     = (team === 'blue' && match.teams?.blue?.has_won) ||
                                    (team === 'red'  && match.teams?.red?.has_won);
                    if (won) wins++; else losses++;
                }

                const kd       = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
                const winrate  = ((wins / matches.length) * 100).toFixed(0);
                const avgKills = (totalKills / matches.length).toFixed(1);
                matchSummary   = `**${wins}W / ${losses}L** (${winrate}% WR) in last ${matches.length} games\nAvg K/D: **${kd}** | Avg Kills: **${avgKills}**`;
            }

            const winrate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 50;

            // ── Build embed ──
            const embed = new EmbedBuilder()
                .setTitle(`${rankEmoji} ${username}#${tag}`)
                .setDescription(`**Region:** ${region.toUpperCase()} • **Account Level:** ${accountLevel}`)
                .setColor(getWinrateColor(winrate))
                .addFields(
                    { name: `${rankEmoji} Current Rank`, value: `**${currentRank}**\n${rr} RR (${mmrChangeStr} last game)`, inline: true },
                    { name: `${peakEmoji} Peak Rank`,    value: `**${peakRank}**`, inline: true },
                    { name: '📊 Last 5 Competitive',     value: matchSummary, inline: false }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag} • Powered by HenrikDev API` })
                .setTimestamp();

            if (card) embed.setThumbnail(card);

            return interaction.editReply({ embeds: [embed] });

        } catch (err) {
            console.error('[ValStats] Error:', err);
            return interaction.editReply(`❌ Something went wrong: ${err.message}`);
        }
    },
};
