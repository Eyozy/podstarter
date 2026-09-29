// @ts-check
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { loadSiteConfig } from './scripts/siteConfig.js';

// https://astro.build/config
export default defineConfig({
  site: loadSiteConfig().site.url,
  output: 'static',
  adapter: netlify(),
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()]
  }
});
