import {
  SlashCommandBuilder,
  PermissionFlagsBits
} from 'discord.js';

import { successEmbed } from '../../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('antinuke')
    .setDescription('Configure anti-nuke')
    .addSubcommand(sub =>
      sub
        .setName('enable')
        .setDescription('Enable anti-nuke')
    )
    .addSubcommand(sub =>
      sub
        .setName('disable')
        .setDescription('Disable anti-nuke')
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    ),

  category: 'moderation',

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();

    const key = `antinuke:${interaction.guild.id}`;

    if (sub === 'enable') {
      await client.db.set(key, true);

      return interaction.reply({
        embeds: [
          successEmbed(
            'Anti-Nuke Enabled',
            'Anti-nuke protection is now enabled.'
          )
        ]
      });
    }

    if (sub === 'disable') {
      await client.db.set(key, false);

      return interaction.reply({
        embeds: [
          successEmbed(
            'Anti-Nuke Disabled',
            'Anti-nuke protection is now disabled.'
          )
        ]
      });
    }
  }
};
