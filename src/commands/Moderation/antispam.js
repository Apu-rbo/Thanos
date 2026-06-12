import {
  SlashCommandBuilder,
  PermissionFlagsBits
} from 'discord.js';

import { successEmbed, errorEmbed } from '../../utils/embeds.js';

export default {
  data: new SlashCommandBuilder()
    .setName('antispam')
    .setDescription('Configure anti-spam')
    .addSubcommand(sub =>
      sub
        .setName('enable')
        .setDescription('Enable anti-spam')
    )
    .addSubcommand(sub =>
      sub
        .setName('disable')
        .setDescription('Disable anti-spam')
    )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    ),

  category: 'moderation',

  async execute(interaction, config, client) {
    const sub = interaction.options.getSubcommand();

    const key = `antispam:${interaction.guild.id}`;

    if (sub === 'enable') {
      await client.db.set(key, true);

      return interaction.reply({
        embeds: [
          successEmbed(
            'Anti-Spam Enabled',
            'Anti-spam protection is now enabled.'
          )
        ]
      });
    }

    if (sub === 'disable') {
      await client.db.set(key, false);

      return interaction.reply({
        embeds: [
          successEmbed(
            'Anti-Spam Disabled',
            'Anti-spam protection is now disabled.'
          )
        ]
      });
    }
  }
};
