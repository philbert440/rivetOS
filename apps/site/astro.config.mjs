import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://rivetos.dev',
  integrations: [
    starlight({
      title: 'RivetOS',
      description: 'AI agent infrastructure that runs anywhere',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        replacesTitle: false,
      },
      social: {
        github: 'https://github.com/philbert440/rivetos',
      },
      editLink: {
        baseUrl: 'https://github.com/philbert440/rivetos/edit/main/apps/site/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          autogenerate: { directory: 'guides' },
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
      ],
      head: [
        {
          tag: 'meta',
          attrs: {
            property: 'og:image',
            content: 'https://rivetos.dev/og.png',
          },
        },
      ],
    }),
  ],
});
