import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { QueueRepeatMode } from 'discord-player';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { handleInteractionError } from '../../utils/errorHandler.js';
import { logger } from '../../utils/logger.js';
import { getPlayer } from '../../services/musicService.js';

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('music')
        .setDescription('Play music in your voice channel')

        .addSubcommand(sub =>
            sub.setName('play')
                .setDescription('Play a song or add it to the queue')
                .addStringOption(o => o.setName('query').setDescription('Song name or URL (YouTube, SoundCloud, Spotify)').setRequired(true))
        )
        .addSubcommand(sub => sub.setName('skip').setDescription('Skip the current song'))
        .addSubcommand(sub => sub.setName('stop').setDescription('Stop playback and clear the queue'))
        .addSubcommand(sub => sub.setName('pause').setDescription('Pause the current song'))
        .addSubcommand(sub => sub.setName('resume').setDescription('Resume playback'))
        .addSubcommand(sub => sub.setName('queue').setDescription('View the current queue'))
        .addSubcommand(sub => sub.setName('nowplaying').setDescription('Show the currently playing song'))
        .addSubcommand(sub => sub.setName('shuffle').setDescription('Shuffle the queue'))
        .addSubcommand(sub => sub.setName('disconnect').setDescription('Disconnect the bot from voice'))
        .addSubcommand(sub =>
            sub.setName('volume')
                .setDescription('Set playback volume')
                .addIntegerOption(o => o.setName('level').setDescription('Volume 0-100').setRequired(true).setMinValue(0).setMaxValue(100))
        )
        .addSubcommand(sub =>
            sub.setName('loop')
                .setDescription('Set loop mode')
                .addStringOption(o =>
                    o.setName('mode').setDescription('Loop mode').setRequired(true)
                        .addChoices(
                            { name: 'Off', value: 'off' },
                            { name: 'Track', value: 'track' },
                            { name: 'Queue', value: 'queue' },
                        )
                )
        ),

    category: 'music',

    async execute(interaction, guildConfig, client) {
        const sub = interaction.options.getSubcommand();
        const player = getPlayer();
        const voiceChannel = interaction.member?.voice?.channel;

        try {
            // ── PLAY ──────────────────────────────────────────────────────────
            if (sub === 'play') {
                if (!voiceChannel) {
                    return InteractionHelper.universalReply(interaction, {
                        embeds: [errorEmbed('Not in Voice', 'Join a voice channel first.')],
                        ephemeral: true,
                    });
                }

                await InteractionHelper.safeDefer(interaction);
                const query = interaction.options.getString('query');

                try {
                    const { track } = await player.play(voiceChannel, query, {
                        nodeOptions: {
                            metadata: { channel: interaction.channel },
                            selfDeaf: true,
                            volume: 70,
                            leaveOnEmpty: true,
                            leaveOnEmptyCooldown: 60000,
                            leaveOnEnd: true,
                            leaveOnEndCooldown: 60000,
                        },
                    });

                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [successEmbed('✅ Added to Queue', `**[${track.title}](${track.url})**\nDuration: ${track.duration}`)],
                    });
                } catch (err) {
                    logger.error('[Music] Play error:', err);
                    return InteractionHelper.safeEditReply(interaction, {
                        embeds: [errorEmbed('Playback Failed', `Couldn't play that: ${err.message || 'No results found or source unavailable.'}`)],
                    });
                }
            }

            // ── Everything below requires an active queue ────────────────────
            const queue = player.nodes.get(interaction.guild.id);

            if (sub === 'skip') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                const skipped = queue.currentTrack;
                queue.node.skip();
                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('⏭️ Skipped', `Skipped **${skipped.title}**.`)],
                });
            }

            if (sub === 'stop') {
                if (!queue) return notPlaying(interaction);
                queue.delete();
                return InteractionHelper.universalReply(interaction, {
                    embeds: [successEmbed('⏹️ Stopped', 'Playback stopped and queue cleared.')],
                });
            }

            if (sub === 'pause') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                queue.node.setPaused(true);
                return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('⏸️ Paused', 'Playback paused.')] });
            }

            if (sub === 'resume') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                queue.node.setPaused(false);
                return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('▶️ Resumed', 'Playback resumed.')] });
            }

            if (sub === 'queue') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                const tracks = queue.tracks.toArray().slice(0, 10);
                const list = tracks.length
                    ? tracks.map((t, i) => `**${i + 1}.** ${t.title} — ${t.duration}`).join('\n')
                    : 'No upcoming tracks.';

                return InteractionHelper.universalReply(interaction, {
                    embeds: [createEmbed({
                        title: '📋 Queue',
                        description: `**Now Playing:** ${queue.currentTrack.title}\n\n${list}${queue.tracks.size > 10 ? `\n\n...and ${queue.tracks.size - 10} more` : ''}`,
                        color: 'primary',
                    })],
                });
            }

            if (sub === 'nowplaying') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                const track = queue.currentTrack;
                const progress = queue.node.createProgressBar?.() ?? '';

                return InteractionHelper.universalReply(interaction, {
                    embeds: [new EmbedBuilder()
                        .setTitle('🎵 Now Playing')
                        .setDescription(`**[${track.title}](${track.url})**\n${progress}`)
                        .setThumbnail(track.thumbnail)
                        .addFields(
                            { name: 'Requested by', value: `${track.requestedBy}`, inline: true },
                            { name: 'Duration', value: track.duration, inline: true },
                        )
                        .setColor(0x5865F2)],
                });
            }

            if (sub === 'shuffle') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                queue.tracks.shuffle();
                return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('🔀 Shuffled', 'Queue has been shuffled.')] });
            }

            if (sub === 'disconnect') {
                if (!queue) return notPlaying(interaction);
                queue.delete();
                return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('👋 Disconnected', 'Left the voice channel.')] });
            }

            if (sub === 'volume') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                const level = interaction.options.getInteger('level');
                queue.node.setVolume(level);
                return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('🔊 Volume Set', `Volume set to **${level}%**.`)] });
            }

            if (sub === 'loop') {
                if (!queue?.currentTrack) return notPlaying(interaction);
                const mode = interaction.options.getString('mode');
                const modeMap = { off: QueueRepeatMode.OFF, track: QueueRepeatMode.TRACK, queue: QueueRepeatMode.QUEUE };
                queue.setRepeatMode(modeMap[mode]);
                return InteractionHelper.universalReply(interaction, { embeds: [successEmbed('🔁 Loop Mode Set', `Loop mode set to **${mode}**.`)] });
            }
        } catch (error) {
            logger.error('Music command error:', error);
            await handleInteractionError(interaction, error, { subtype: 'music_failed' });
        }
    },
};

function notPlaying(interaction) {
    return InteractionHelper.universalReply(interaction, {
        embeds: [errorEmbed('Nothing Playing', 'There is no active queue in this server.')],
        ephemeral: true,
    });
}
