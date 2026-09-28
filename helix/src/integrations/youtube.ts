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
  private config: YouTubeConfig;
  /*
   * Kept so the client can be rebuilt.
   *
   * A new OAuth2Client is a new event emitter, so the refresh handler has to
   * be re-attached to it or renewed tokens stop being persisted — silently,
   * and only an hour later.
   */
  private refreshHandler:
    | ((accessToken: string, refreshToken: string | null, expiresAt?: number) => void)
    | null = null;

  constructor(config: YouTubeConfig) {
    this.config = { ...config };
    this.auth = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUrl);
  }

  /**
   * Swap in a different client id and secret without a restart.
   *
   * Any tokens held are dropped rather than carried over: they were issued to
   * the previous OAuth client and are not valid for this one. Saying nothing
   * and keeping them would present later as an authorisation that mysteriously
   * stopped working.
   */
  reconfigure(config: YouTubeConfig): void {
    this.config = { ...config };
    this.auth = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUrl);
    if (this.refreshHandler !== null) this.attachRefresh(this.refreshHandler);
  }

  /** Whether it has been given a client at all. */
  get configured(): boolean {
    return this.config.clientId !== '' && this.config.clientSecret !== '';
  }

  private attachRefresh(
    handler: (accessToken: string, refreshToken: string | null, expiresAt?: number) => void
  ): void {
    this.auth.on('tokens', (tokens) => {
      if (!tokens.access_token) return;
      handler(tokens.access_token, tokens.refresh_token ?? null, tokens.expiry_date ?? undefined);
    });
  }

  getAuthUrl(
    scopes: string[] = [
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ],
    redirectUrl?: string
  ) {
    return this.auth.generateAuthUrl({
      access_type: 'offline',
      // Overridden per request so the callback comes back to wherever Helix
      // was actually reached — localhost on this machine, the tailnet name
      // from a phone. Both have to be registered with Google; whichever one
      // was used to start the flow is the one Google is sent.
      ...(redirectUrl === undefined ? {} : { redirect_uri: redirectUrl }),
      // Google returns a refresh token only on the first authorisation unless
      // consent is re-prompted; without one the connection cannot outlive the
      // access token's hour.
      prompt: 'consent',
      scope: scopes,
    });
  }

  /**
   * The library refreshes the access token on its own once it expires. Without
   * somewhere to put the replacement the caller keeps persisting the stale one
   * and refreshes again on every request, and a rotated refresh token would be
   * lost outright.
   */
  onTokenRefresh(handler: (accessToken: string, refreshToken: string | null, expiresAt?: number) => void) {
    this.refreshHandler = handler;
    this.attachRefresh(handler);
  }

  async setCredentials(code: string, redirectUrl?: string) {
    // Google requires the redirect_uri here to be byte-identical to the one
    // the flow was started with, so the caller passes the same value back.
    // Branched rather than passed as a union: the two forms are separate
    // overloads and a union satisfies neither.
    const { tokens } =
      redirectUrl === undefined
        ? await this.auth.getToken(code)
        : await this.auth.getToken({ code, redirect_uri: redirectUrl });
    this.auth.setCredentials(tokens);
    return tokens;
  }

  async setAccessToken(
    accessToken: string,
    refreshToken: string | null = null,
    expiresAt?: number
  ) {
    // expiry_date is what drives the library's automatic refresh: its
    // isTokenExpiring() returns false whenever the field is absent, so leaving
    // it out means the token is never renewed and calls start failing after
    // roughly an hour.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const creds: any = {
      access_token: accessToken,
      refresh_token: refreshToken ?? null,
    };
    if (expiresAt !== undefined) creds.expiry_date = expiresAt;
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
