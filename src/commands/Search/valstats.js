import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';

// Rank tier to emoji mapping
const RANK_EMOJIS = {
    'Iron': '🩶',
    'Bronze': '🥉',
    'Silver': '🥈',
    'Gold': '🥇',
    'Platinum': '💎',
    'Diamond': '💠',
    'Ascendant': '🌿',
    'Immortal': '👑',
    'Radiant': '✨',
    'Unranked': '❓',
};

function getRankEmoji(tier) {
    for (const [key, emoji] of Object.entries(RANK_EMOJIS)) {
        if (tier?.toLowerCase().includes(key.toLowerCase())) return emoji;
    }
    return '❓';
}

function getWinrateColor(winrate) {
    if (winrate >= 55) return 0x00FF7F;   // green
    if (winrate >= 50) return 0xFFD700;   // gold
    if (winrate >= 45) return 0xFF8C00;   // orange
    return 0xFF4444;                       // red
}

export default {
    data: new SlashCommandBuilder()
        .setName('valstats')
        .setDescription('Look up Valorant stats for a player')
        .addStringOption(option =>
            option
                .setName('username')
                .setDescription('Riot ID username (e.g. TenZ)')
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName('tag')
                .setDescription('Riot tag WITHOUT # (e.g. NA1)')
                .setRequired(true)
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

        try {
            // ── Fetch MMR (rank) data ──
            const mmrRes = await fetch(
                `https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`,
                { headers: { 'Authorization': apiKey } }
            );
            const mmrData = await mmrRes.json();

            if (mmrData.status !== 200) {
                const reason = mmrData.errors?.[0]?.message || mmrData.message || 'Player not found.';
                return interaction.editReply(`❌ Could not find player **${username}#${tag}**: ${reason}`);
            }

            // ── Fetch general account data ──
            const accountRes = await fetch(
                `https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`,
                { headers: { 'Authorization': apiKey } }
            );
            const accountData = await accountRes.json();

            // ── Fetch last 5 matches ──
            const matchRes = await fetch(
                `https://api.henrikdev.xyz/valorant/v3/matches/${region}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}?mode=competitive&size=5`,
                { headers: { 'Authorization': apiKey } }
            );
            const matchData = await matchRes.json();

            // ── Parse MMR ──
            const current     = mmrData.data?.current_data;
            const currentRank = current?.currenttierpatched ?? 'Unranked';
            const rankEmoji   = getRankEmoji(currentRank);
            const rr          = current?.ranking_in_tier ?? 0;
            const mmrChange   = current?.mmr_change_to_last_game ?? 0;
            const mmrChangeStr = mmrChange > 0 ? `+${mmrChange}` : `${mmrChange}`;
            const peakRank    = mmrData.data?.highest_rank?.patched_tier ?? 'N/A';
            const peakEmoji   = getRankEmoji(peakRank);

            // ── Parse account ──
            const accountLevel = accountData.data?.account_level ?? 'N/A';
            const card         = accountData.data?.card?.small ?? null;

            // ── Parse recent matches ──
            let matchSummary = 'No recent competitive matches found.';
            let totalKills = 0, totalDeaths = 0, totalAssists = 0;
            let wins = 0, losses = 0;

            if (matchData.status === 200 && matchData.data?.length > 0) {
                const matches = matchData.data;

                for (const match of matches) {
                    const player = match.players?.all_players?.find(
                        p => p.name.toLowerCase() === username.toLowerCase() &&
                             p.tag.toLowerCase() === tag.toLowerCase()
                    );
                    if (!player) continue;

                    totalKills   += player.stats?.kills   ?? 0;
                    totalDeaths  += player.stats?.deaths  ?? 0;
                    totalAssists += player.stats?.assists ?? 0;

                    const team      = player.team?.toLowerCase();
                    const blueWon   = match.teams?.blue?.has_won;
                    const redWon    = match.teams?.red?.has_won;
                    const playerWon = (team === 'blue' && blueWon) || (team === 'red' && redWon);
                    if (playerWon) wins++; else losses++;
                }

                const kd       = totalDeaths > 0 ? (totalKills / totalDeaths).toFixed(2) : totalKills.toFixed(2);
                const winrate  = matches.length > 0 ? ((wins / matches.length) * 100).toFixed(0) : 0;
                const avgKills = (totalKills / matches.length).toFixed(1);

                matchSummary = `**${wins}W / ${losses}L** (${winrate}% WR) in last ${matches.length} games\nAvg K/D: **${kd}** | Avg Kills: **${avgKills}**`;
            }

            // ── Build embed ──
            const winrate = wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 50;

            const embed = new EmbedBuilder()
                .setTitle(`${rankEmoji} ${username}#${tag}`)
                .setDescription(`**Region:** ${region.toUpperCase()} • **Account Level:** ${accountLevel}`)
                .setColor(getWinrateColor(winrate))
                .addFields(
                    {
                        name: `${rankEmoji} Current Rank`,
                        value: `**${currentRank}**\n${rr} RR (${mmrChangeStr} last game)`,
                        inline: true,
                    },
                    {
                        name: `${peakEmoji} Peak Rank`,
                        value: `**${peakRank}**`,
                        inline: true,
                    },
                    {
                        name: '📊 Last 5 Competitive',
                        value: matchSummary,
                        inline: false,
                    }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag} • Powered by HenrikDev API` })
                .setTimestamp();

            if (card) embed.setThumbnail(card);

            return interaction.editReply({ embeds: [embed] });

        } catch (err) {
            console.error('[ValStats] Error:', err);
            return interaction.editReply('❌ Something went wrong fetching stats. Please try again later.');
        }
    },
};
