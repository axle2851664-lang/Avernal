import { OAuth2Client } from 'google-auth-library';

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
}

export interface Video {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  channelTitle: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  transcript?: string;
}

export class YouTubeSync {
  private auth: OAuth2Client;

  constructor(config: YouTubeConfig) {
    this.auth = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUrl);
  }

  getAuthUrl(scopes: string[] = [
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
  ]) {
    return this.auth.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
    });
  }

  async setCredentials(code: string) {
    const { tokens } = await this.auth.getToken(code);
    this.auth.setCredentials(tokens);
    return tokens;
  }

  async setAccessToken(accessToken: string, refreshToken: string | null = null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const creds: any = {
      access_token: accessToken,
      refresh_token: refreshToken ?? null,
    };
    this.auth.setCredentials(creds);
  }

  async fetchChannelVideos(maxResults = 10): Promise<Video[]> {
    try {
      const { google } = await import('googleapis');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const youtube = (google.youtube as any)({ version: 'v3', auth: this.auth });

      const channelsRes = await youtube.channels.list({
        part: 'contentDetails',
        mine: true,
      });

      const uploadPlaylistId = channelsRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploadPlaylistId) {
        throw new Error('Could not find uploads playlist');
      }

      const playlistRes = await youtube.playlistItems.list({
        part: 'contentDetails',
        playlistId: uploadPlaylistId,
        maxResults,
      });

      const videoIds = playlistRes.data.items?.map((item: Record<string, unknown>) => {
        const contentDetails = item.contentDetails as Record<string, unknown>;
        return contentDetails.videoId;
      }) || [];

      if (!videoIds.length) return [];

      const videosRes = await youtube.videos.list({
        part: 'snippet,statistics',
        id: videoIds.join(','),
      });

      return (videosRes.data.items || []).map((item: Record<string, unknown>) => {
        const snippet = item.snippet as Record<string, unknown>;
        const stats = item.statistics as Record<string, unknown>;
        return {
          id: item.id as string,
          title: (snippet.title as string) || '',
          description: (snippet.description as string) || '',
          publishedAt: (snippet.publishedAt as string) || '',
          channelTitle: (snippet.channelTitle as string) || '',
          viewCount: parseInt((stats.viewCount as string) || '0', 10),
          likeCount: parseInt((stats.likeCount as string) || '0', 10),
          commentCount: parseInt((stats.commentCount as string) || '0', 10),
        };
      });
    } catch (error) {
      console.error('Error fetching YouTube videos:', error);
      throw error;
    }
  }

  async fetchVideoTranscript(videoId: string): Promise<string | undefined> {
    try {
      // Using the YouTubeTranscriptAPI pattern - would need youtube-transcript-api or similar
      // For now, return undefined; transcripts require additional setup
      console.log('Transcript fetch not yet implemented for video:', videoId);
      return undefined;
    } catch (error) {
      console.error('Error fetching transcript:', error);
      return undefined;
    }
  }
}
