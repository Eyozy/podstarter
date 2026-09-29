import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { loadSiteConfig } from "../../scripts/siteConfig.js";
const site = loadSiteConfig();
import { publishedEpisodes } from '../utils/episodes';

const escapeXmlAttr = (str: string = ''): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function parseValidDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export const GET: APIRoute = async (context) => {
  const siteUrl = (site.site?.url || context.site?.toString() || '').replace(/\/+$/, '');
  const author = escapeXmlAttr(site.brand?.meta?.author || site.brand?.name || '');
  const defaultCover = escapeXmlAttr(site.assets?.defaultCover || '');

  return rss({
    title: site.brand?.name || 'Podcast',
    description: site.brand?.meta?.description || '',
    site: siteUrl,
    xmlns: {
      itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
      content: 'http://purl.org/rss/1.0/modules/content/',
    },
    customData: `<language>zh-cn</language>
<itunes:author>${author}</itunes:author>
<itunes:image href="${defaultCover}" />
<itunes:category text="Society &amp; Culture" />`,
    items: publishedEpisodes.map((ep) => {
      const rawUrl = ep.enclosure?.url || '';
      const fullEnclosureUrl = rawUrl.startsWith('/') ? `${siteUrl}${rawUrl}` : rawUrl;
      const enclosureUrl = escapeXmlAttr(fullEnclosureUrl);
      const enclosureLength = escapeXmlAttr(ep.enclosure?.length || '0');
      const enclosureType = escapeXmlAttr(ep.enclosure?.type || 'audio/x-m4a');
      const duration = escapeXmlAttr(ep.itunes?.duration || '');
      const itemCover = escapeXmlAttr(ep.itunes?.image || site.assets?.defaultCover || '');
      const episodeTag = ep.itunes?.episode
        ? `<itunes:episode>${escapeXmlAttr(String(ep.itunes.episode))}</itunes:episode>`
        : '';

      return {
        title: ep.title,
        pubDate: parseValidDate(ep.pubDate),
        description: ep.contentSnippet || ep.content || '',
        link: `/episodes/${ep.id}`,
        customData: `<enclosure url="${enclosureUrl}" length="${enclosureLength}" type="${enclosureType}" />
<itunes:duration>${duration}</itunes:duration>
<itunes:image href="${itemCover}" />
${episodeTag}`,
      };
    }),
  });
};
