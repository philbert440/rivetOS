import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://rivetos.dev',
  redirects: {
    '/docs': '/guides/getting-started/',
    '/docs/cloud': '/guides/cloud/',
    '/docs/cloud/': '/guides/cloud/',
  },
  integrations: [
    starlight({
      title: 'RivetOS',
      favicon: '/favicon.png',
      description: 'AI agent infrastructure that runs anywhere',
      logo: {
        src: './src/assets/robot.png',
        replacesTitle: false,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/philbert440/rivetOS',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/philbert440/rivetOS/edit/main/apps/site/',
      },
      customCss: ['./src/styles/custom.css'],
      components: {
        Head: './src/components/Head.astro',
        Footer: './src/components/Footer.astro',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
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
