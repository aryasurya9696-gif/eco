import type { MonitoredPost } from '../types';

export const INITIAL_SEED_KEYWORDS: string[] = [
  "ai agents",
  "b2b lead gen",
  "sales automation",
  "outbound pipeline",
];

export const generateSeedPosts = (userId: string, activeKeywords: string[]): MonitoredPost[] => {
  const samplePosts: Omit<MonitoredPost, 'id' | 'user_id' | 'created_at'>[] = [
    {
      matched_keyword: "ai agents",
      platform: "twitter",
      post_url: "https://x.com/alexrivera_tech/status/1789234892301",
      author_name: "Alex Rivera",
      author_handle: "@alexrivera_tech",
      author_avatar_url: null,
      body: "We are migrating our entire outbound prospect qualification flow to autonomous ai agents next week. Currently vetting solutions for CRM enrichment and automatic lead intent scoring. Who are the top 3 contenders I should test right now?",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours ago
      intent_score: 96,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 42,
        retweets: 11,
        replies: 28,
      },
      raw: {
        follower_count: 14200,
        verified: true,
        source: "X for Mac",
      },
    },
    {
      matched_keyword: "b2b lead gen",
      platform: "linkedin",
      post_url: "https://www.linkedin.com/posts/sarah-chen-growth_b2bleadgen-growthmarketing-activity-7182938491829",
      author_name: "Sarah Chen",
      author_handle: "VP of Growth @ Horizon Scale",
      author_avatar_url: null,
      body: "Traditional cold email open rates dropped 35% across our portfolio companies this quarter. We're actively shifting our budget toward real-time social listening and buyer-intent triggers on LinkedIn and X. Looking for tools that monitor specific competitor mentions and procurement signals without the enterprise Bloatware pricing.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(), // 5 hours ago
      intent_score: 94,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 124,
        comments: 49,
        reposts: 18,
      },
      raw: {
        connections: "500+",
        company_size: "51-200 employees",
      },
    },
    {
      matched_keyword: "sales automation",
      platform: "twitter",
      post_url: "https://x.com/marcus_founder/status/1789104829103",
      author_name: "Marcus Vance",
      author_handle: "@marcus_founder",
      author_avatar_url: null,
      body: "Our sales reps spend over 2 hours every day manually scrolling LinkedIn and Twitter to find prospects complaining about their legacy ERP software. If anyone has built clean sales automation that scrapes these mentions into a daily digest, DM me immediately. Budget is ready.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 9).toISOString(), // 9 hours ago
      intent_score: 98,
      intent_level: "high",
      status: "saved",
      engagement: {
        likes: 88,
        retweets: 15,
        replies: 34,
      },
      raw: {
        follower_count: 8900,
        bio: "Founder @ Veloce. Building for RevOps leaders.",
      },
    },
    {
      matched_keyword: "outbound pipeline",
      platform: "linkedin",
      post_url: "https://www.linkedin.com/posts/elena-rostova-revops_outboundpipeline-salestech-activity-7183019284910",
      author_name: "Elena Rostova",
      author_handle: "Head of RevOps @ NovaTech Systems",
      author_avatar_url: null,
      body: "Building our outbound pipeline playbook for H2. Trigger-based monitoring has outperformed generic inbound forms by 3.2x in meeting conversion. Key takeaway: timing is everything. If you reach out within 24 hours of an executive expressing a pain point publicly, conversion hits 22%.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 14).toISOString(), // 14 hours ago
      intent_score: 82,
      intent_level: "medium",
      status: "new",
      engagement: {
        likes: 215,
        comments: 63,
        reposts: 27,
      },
    },
    {
      matched_keyword: "ai agents",
      platform: "linkedin",
      post_url: "https://www.linkedin.com/posts/david-kim-ai_artificialintelligence-autonomousagents-activity-7182991029381",
      author_name: "David Kim",
      author_handle: "Founder & CTO @ NexusLabs",
      author_avatar_url: null,
      body: "Tested 6 different autonomous ai agents frameworks this month for enterprise document processing and lead discovery. The biggest bottleneck remains accurate social signal parsing. What APIs are people using to extract clean post bodies and verified profiles from Twitter/X and LinkedIn?",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(), // 18 hours ago
      intent_score: 89,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 93,
        comments: 31,
        reposts: 12,
      },
    },
    {
      matched_keyword: "b2b lead gen",
      platform: "twitter",
      post_url: "https://x.com/jordan_saas/status/1789012391024",
      author_name: "Jordan Lee",
      author_handle: "@jordan_saas",
      author_avatar_url: null,
      body: "Unpopular opinion: intent data providers charge $20k/year for stale IP-lookup lists when you can find 10x higher intent leads just tracking 5 specific keywords on X, Reddit, and LinkedIn every morning. Anyone else doing this?",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 22).toISOString(), // 22 hours ago
      intent_score: 76,
      intent_level: "medium",
      status: "contacted",
      engagement: {
        likes: 341,
        retweets: 47,
        replies: 76,
      },
    },
    {
      matched_keyword: "b2b lead gen",
      platform: "reddit",
      channel_source: "r/SaaS",
      post_url: "https://www.reddit.com/r/SaaS/comments/1ct982a/best_tools_for_monitoring_social_buyer_intent/",
      author_name: "Liam O'Connor",
      author_handle: "u/liam_growth",
      author_avatar_url: null,
      body: "Looking for recommendations: what's the best tool right now to monitor b2b lead gen intent signals on Reddit, X, and LinkedIn? We have budget approved for Q3 and want to replace our manual SDR searching with automated keyword sweeps.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(), // 3 hours ago
      intent_score: 97,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 78,
        comments: 42,
        reposts: null,
      },
      raw: {
        subreddit: "r/SaaS",
        upvotes: 78,
        upvote_ratio: "96%",
      },
    },
    {
      matched_keyword: "sales automation",
      platform: "reddit",
      channel_source: "r/startups",
      post_url: "https://www.reddit.com/r/startups/comments/1cs819p/replacing_cold_email_with_intent_monitoring/",
      author_name: "Maya Patel",
      author_handle: "u/mayastartups",
      author_avatar_url: null,
      body: "Has anyone successfully transitioned their outbound pipeline into sales automation that triggers off public prospect questions on Reddit and LinkedIn? We get 10x higher response rates when reaching out to someone asking for tool recommendations compared to generic cold outreach.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(), // 6 hours ago
      intent_score: 93,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 114,
        comments: 65,
        reposts: null,
      },
      raw: {
        subreddit: "r/startups",
        upvotes: 114,
      },
    },
    {
      matched_keyword: "ai agents",
      platform: "facebook",
      channel_source: "B2B SaaS Founders Group",
      post_url: "https://www.facebook.com/groups/saasfounders/posts/9182391029381/",
      author_name: "Robert Torres",
      author_handle: "Robert Torres (Founder @ ScaleEngine)",
      author_avatar_url: null,
      body: "Quick question for the group: We are evaluating ai agents to qualify leads from community discussions and social posts across Facebook groups, LinkedIn, and X. Does anyone have direct experience with Echo or similar platforms? Need something that syncs with our CRM.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 8).toISOString(), // 8 hours ago
      intent_score: 95,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 53,
        comments: 27,
        reposts: 8,
      },
      raw: {
        group_name: "B2B SaaS Founders & Growth Hackers",
        group_members: "42,000 members",
      },
    },
    {
      matched_keyword: "outbound pipeline",
      platform: "google",
      channel_source: "Google Discussions & Forums",
      post_url: "https://community.hubspot.com/t5/Sales-Hub/Best-solutions-for-outbound-pipeline-intent-data/m-p/912830",
      author_name: "Chloe Vance",
      author_handle: "Chloe Vance @ RevOpsHub",
      author_avatar_url: null,
      body: "Forum Thread: Best solutions for outbound pipeline intent data in 2026? Evaluating options to monitor social keyword mentions across Reddit, Google discussions, X, and LinkedIn. Need accurate lead scoring and non-bloated pricing.",
      posted_at: new Date(Date.now() - 1000 * 60 * 60 * 11).toISOString(), // 11 hours ago
      intent_score: 91,
      intent_level: "high",
      status: "new",
      engagement: {
        likes: 36,
        comments: 19,
        reposts: null,
      },
      raw: {
        source_domain: "community.hubspot.com",
        search_query: "outbound pipeline intent data tool",
      },
    },
  ];

  const filtered = activeKeywords.length > 0
    ? samplePosts.filter(p => activeKeywords.some(kw => kw.toLowerCase() === p.matched_keyword.toLowerCase()))
    : samplePosts;

  const results = filtered.length > 0 ? filtered : samplePosts;

  return results.map((post, idx) => ({
    ...post,
    id: `post-seed-${idx + 1}-${Date.now()}`,
    user_id: userId,
    created_at: new Date(Date.now() - idx * 1000 * 60 * 60 * 3).toISOString(),
  }));
};
