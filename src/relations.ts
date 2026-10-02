import { defineRelations } from "drizzle-orm";

import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  passkeys: {
    credential: r.one.credentials({
      from: r.passkeys.credentialEmail,
      to: r.credentials.email,
      optional: false,
    }),
  },
  accounts: {
    owner: r.one.accountOwners({
      from: r.accounts.id,
      to: r.accountOwners.id,
    }),
    successor: r.one.accounts({
      from: r.accounts.successorId,
      to: r.accounts.id,
      alias: "successor",
    }),
    predecessors: r.many.accounts({
      from: r.accounts.id,
      to: r.accounts.successorId,
      alias: "successor",
    }),
    following: r.many.follows({
      from: r.accounts.id,
      to: r.follows.followerId,
      alias: "following",
    }),
    followers: r.many.follows({
      from: r.accounts.id,
      to: r.follows.followingId,
      alias: "follower",
    }),
    posts: r.many.posts({ from: r.accounts.id, to: r.posts.accountId }),
    mentions: r.many.mentions({
      from: r.accounts.id,
      to: r.mentions.accountId,
    }),
    likes: r.many.likes({ from: r.accounts.id, to: r.likes.accountId }),
    pinnedPosts: r.many.pinnedPosts({
      from: r.accounts.id,
      to: r.pinnedPosts.accountId,
    }),
    mutes: r.many.mutes({
      from: r.accounts.id,
      to: r.mutes.accountId,
      alias: "muter",
    }),
    mutedBy: r.many.mutes({
      from: r.accounts.id,
      to: r.mutes.mutedAccountId,
      alias: "muted",
    }),
    blocks: r.many.blocks({
      from: r.accounts.id,
      to: r.blocks.accountId,
      alias: "blocker",
    }),
    blockedBy: r.many.blocks({
      from: r.accounts.id,
      to: r.blocks.blockedAccountId,
      alias: "blocked",
    }),
    instance: r.one.instances({
      from: r.accounts.instanceHost,
      to: r.instances.host,
      optional: false,
    }),
  },
  accountOwners: {
    account: r.one.accounts({
      from: r.accountOwners.id,
      to: r.accounts.id,
      optional: false,
    }),
    accessTokens: r.many.accessTokens({
      from: r.accountOwners.id,
      to: r.accessTokens.accountOwnerId,
    }),
    bookmarks: r.many.bookmarks({
      from: r.accountOwners.id,
      to: r.bookmarks.accountOwnerId,
    }),
    markers: r.many.markers({
      from: r.accountOwners.id,
      to: r.markers.accountOwnerId,
    }),
    featuredTags: r.many.featuredTags({
      from: r.accountOwners.id,
      to: r.featuredTags.accountOwnerId,
    }),
    lists: r.many.lists({
      from: r.accountOwners.id,
      to: r.lists.accountOwnerId,
    }),
    importJobs: r.many.importJobs({
      from: r.accountOwners.id,
      to: r.importJobs.accountOwnerId,
    }),
  },
  instances: {
    accounts: r.many.accounts({
      from: r.instances.host,
      to: r.accounts.instanceHost,
    }),
  },
  follows: {
    following: r.one.accounts({
      from: r.follows.followingId,
      to: r.accounts.id,
      alias: "follower",
      optional: false,
    }),
    follower: r.one.accounts({
      from: r.follows.followerId,
      to: r.accounts.id,
      alias: "following",
      optional: false,
    }),
  },
  applications: {
    accessTokens: r.many.accessTokens({
      from: r.applications.id,
      to: r.accessTokens.applicationId,
    }),
  },
  accessGrants: {
    application: r.one.applications({
      from: r.accessGrants.applicationId,
      to: r.applications.id,
      optional: false,
    }),
    accountOwner: r.one.accountOwners({
      from: r.accessGrants.resourceOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
  },
  accessTokens: {
    application: r.one.applications({
      from: r.accessTokens.applicationId,
      to: r.applications.id,
      optional: false,
    }),
    accountOwner: r.one.accountOwners({
      from: r.accessTokens.accountOwnerId,
      to: r.accountOwners.id,
    }),
  },
  posts: {
    account: r.one.accounts({
      from: r.posts.accountId,
      to: r.accounts.id,
      optional: false,
    }),
    application: r.one.applications({
      from: r.posts.applicationId,
      to: r.applications.id,
    }),
    replyTarget: r.one.posts({
      from: r.posts.replyTargetId,
      to: r.posts.id,
      alias: "reply",
    }),
    replies: r.many.posts({
      from: r.posts.id,
      to: r.posts.replyTargetId,
      alias: "reply",
    }),
    likes: r.many.likes({ from: r.posts.id, to: r.likes.postId }),
    reactions: r.many.reactions({
      from: r.posts.id,
      to: r.reactions.postId,
    }),
    sharing: r.one.posts({
      from: r.posts.sharingId,
      to: r.posts.id,
      alias: "share",
    }),
    shares: r.many.posts({
      from: r.posts.id,
      to: r.posts.sharingId,
      alias: "share",
    }),
    quoteTarget: r.one.posts({
      from: r.posts.quoteTargetId,
      to: r.posts.id,
      alias: "quote",
    }),
    quotes: r.many.posts({
      from: r.posts.id,
      to: r.posts.quoteTargetId,
      alias: "quote",
    }),
    media: r.many.media({ from: r.posts.id, to: r.media.postId }),
    poll: r.one.polls({ from: r.posts.pollId, to: r.polls.id }),
    mentions: r.many.mentions({ from: r.posts.id, to: r.mentions.postId }),
    bookmarks: r.many.bookmarks({
      from: r.posts.id,
      to: r.bookmarks.postId,
    }),
    pin: r.one.pinnedPosts({
      from: [r.posts.id, r.posts.accountId],
      to: [r.pinnedPosts.postId, r.pinnedPosts.accountId],
    }),
  },
  media: {
    post: r.one.posts({ from: r.media.postId, to: r.posts.id }),
  },
  polls: {
    posts: r.many.posts({ from: r.polls.id, to: r.posts.pollId }),
    options: r.many.pollOptions({
      from: r.polls.id,
      to: r.pollOptions.pollId,
    }),
    votes: r.many.pollVotes({ from: r.polls.id, to: r.pollVotes.pollId }),
  },
  pollOptions: {
    poll: r.one.polls({
      from: r.pollOptions.pollId,
      to: r.polls.id,
      optional: false,
    }),
    votes: r.many.pollVotes({
      from: [r.pollOptions.pollId, r.pollOptions.index],
      to: [r.pollVotes.pollId, r.pollVotes.optionIndex],
    }),
  },
  pollVotes: {
    poll: r.one.polls({
      from: r.pollVotes.pollId,
      to: r.polls.id,
      optional: false,
    }),
    option: r.one.pollOptions({
      from: [r.pollVotes.pollId, r.pollVotes.optionIndex],
      to: [r.pollOptions.pollId, r.pollOptions.index],
      optional: false,
    }),
    account: r.one.accounts({
      from: r.pollVotes.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  mentions: {
    post: r.one.posts({
      from: r.mentions.postId,
      to: r.posts.id,
      optional: false,
    }),
    account: r.one.accounts({
      from: r.mentions.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  pinnedPosts: {
    post: r.one.posts({
      from: [r.pinnedPosts.postId, r.pinnedPosts.accountId],
      to: [r.posts.id, r.posts.accountId],
      optional: false,
    }),
    account: r.one.accounts({
      from: r.pinnedPosts.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  likes: {
    post: r.one.posts({
      from: r.likes.postId,
      to: r.posts.id,
      optional: false,
    }),
    account: r.one.accounts({
      from: r.likes.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  reactions: {
    post: r.one.posts({
      from: r.reactions.postId,
      to: r.posts.id,
      optional: false,
    }),
    account: r.one.accounts({
      from: r.reactions.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  bookmarks: {
    post: r.one.posts({
      from: r.bookmarks.postId,
      to: r.posts.id,
      optional: false,
    }),
    accountOwner: r.one.accountOwners({
      from: r.bookmarks.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
  },
  markers: {
    accountOwner: r.one.accountOwners({
      from: r.markers.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
  },
  featuredTags: {
    accountOwner: r.one.accountOwners({
      from: r.featuredTags.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
  },
  lists: {
    accountOwner: r.one.accountOwners({
      from: r.lists.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
    members: r.many.listMembers({
      from: r.lists.id,
      to: r.listMembers.listId,
    }),
  },
  listMembers: {
    list: r.one.lists({
      from: r.listMembers.listId,
      to: r.lists.id,
      optional: false,
    }),
    account: r.one.accounts({
      from: r.listMembers.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  mutes: {
    account: r.one.accounts({
      from: r.mutes.accountId,
      to: r.accounts.id,
      alias: "muter",
      optional: false,
    }),
    targetAccount: r.one.accounts({
      from: r.mutes.mutedAccountId,
      to: r.accounts.id,
      alias: "muted",
      optional: false,
    }),
  },
  blocks: {
    account: r.one.accounts({
      from: r.blocks.accountId,
      to: r.accounts.id,
      alias: "blocker",
      optional: false,
    }),
    blockedAccount: r.one.accounts({
      from: r.blocks.blockedAccountId,
      to: r.accounts.id,
      alias: "blocked",
      optional: false,
    }),
  },
  reports: {
    account: r.one.accounts({
      from: r.reports.accountId,
      to: r.accounts.id,
      optional: false,
    }),
    targetAccount: r.one.accounts({
      from: r.reports.targetAccountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  notifications: {
    accountOwner: r.one.accountOwners({
      from: r.notifications.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
    actorAccount: r.one.accounts({
      from: r.notifications.actorAccountId,
      to: r.accounts.id,
    }),
    targetPost: r.one.posts({
      from: r.notifications.targetPostId,
      to: r.posts.id,
    }),
    targetAccount: r.one.accounts({
      from: r.notifications.targetAccountId,
      to: r.accounts.id,
    }),
    targetPoll: r.one.polls({
      from: r.notifications.targetPollId,
      to: r.polls.id,
    }),
  },
  notificationGroups: {
    accountOwner: r.one.accountOwners({
      from: r.notificationGroups.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
    targetPost: r.one.posts({
      from: r.notificationGroups.targetPostId,
      to: r.posts.id,
    }),
    mostRecentNotification: r.one.notifications({
      from: r.notificationGroups.mostRecentNotificationId,
      to: r.notifications.id,
    }),
  },
  timelinePosts: {
    account: r.one.accountOwners({
      from: r.timelinePosts.accountId,
      to: r.accountOwners.id,
      optional: false,
    }),
    post: r.one.posts({
      from: r.timelinePosts.postId,
      to: r.posts.id,
      optional: false,
    }),
  },
  listPosts: {
    list: r.one.lists({
      from: r.listPosts.listId,
      to: r.lists.id,
      optional: false,
    }),
    post: r.one.posts({
      from: r.listPosts.postId,
      to: r.posts.id,
      optional: false,
    }),
  },
  importJobs: {
    accountOwner: r.one.accountOwners({
      from: r.importJobs.accountOwnerId,
      to: r.accountOwners.id,
      optional: false,
    }),
    items: r.many.importJobItems({
      from: r.importJobs.id,
      to: r.importJobItems.jobId,
    }),
  },
  importJobItems: {
    effect: r.one.importJobEffects({
      from: r.importJobItems.id,
      to: r.importJobEffects.itemId,
    }),
    job: r.one.importJobs({
      from: r.importJobItems.jobId,
      to: r.importJobs.id,
      optional: false,
    }),
  },
  importJobEffects: {
    item: r.one.importJobItems({
      from: r.importJobEffects.itemId,
      to: r.importJobItems.id,
      optional: false,
    }),
  },
  cleanupJobs: {
    items: r.many.cleanupJobItems({
      from: r.cleanupJobs.id,
      to: r.cleanupJobItems.jobId,
    }),
  },
  cleanupJobItems: {
    job: r.one.cleanupJobs({
      from: r.cleanupJobItems.jobId,
      to: r.cleanupJobs.id,
      optional: false,
    }),
  },
  remoteReplyScrapeJobs: {
    post: r.one.posts({
      from: r.remoteReplyScrapeJobs.postId,
      to: r.posts.id,
      optional: false,
    }),
  },
}));
