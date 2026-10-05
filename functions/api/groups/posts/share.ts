import type { PagesFunction } from "@cloudflare/workers-types";
import { createNotification } from "../../../utils/createNotification";

type Env = { DB: D1Database };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-id",
};

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const toNum = (v: any, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, { status: 204, headers: cors });

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    const body = await request.json().catch(() => ({} as any));

    const headerUserId = toNum(request.headers.get("x-user-id"), 0);
    const bodyUserId = toNum(body.user_id, 0);
    const user_id = headerUserId || bodyUserId || 0;

    const post_id = toNum(body.post_id || body.postId || body.id, 0);
    const group_id = toNum(body.group_id || body.groupId, 0);

    const destination = String(body.destination || "feed").trim().toLowerCase();
    const message = typeof body.message === "string" ? body.message.trim() : (typeof body.content === "string" ? body.content.trim() : null);

    if (!user_id || !post_id) {
      return json({ success: false, error: "user_id and post_id required" }, 400);
    }

    /* --------------------------------------------------
       Ensure group_post_shares table exists
    ---------------------------------------------------*/
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS group_post_shares (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          group_post_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          destination TEXT NOT NULL DEFAULT 'feed',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          message TEXT,
          metadata TEXT
        )
      `).run();
    } catch (_) {}

    /* --------------------------------------------------
       Ensure group post exists
    ---------------------------------------------------*/
    let post = await env.DB.prepare(
      `SELECT gp.*, 
              g.name AS group_name, 
              g.profile_image AS group_image, 
              g.is_verified AS is_group_verified, 
              g.admin_id AS group_admin_id
       FROM group_posts gp
       LEFT JOIN groups g ON g.id = gp.group_id
       WHERE gp.id = ?
       LIMIT 1`
    )
      .bind(post_id)
      .first<any>();

    if (!post && (body.post || body.shared_post)) {
      post = body.post || body.shared_post;
    }

    if (!post) {
      return json({ success: false, error: "Group post not found" }, 404);
    }

    const resolvedGroupId = toNum(post.group_id || group_id, 0);

    /* --------------------------------------------------
       Ensure user is group member or admin
    ---------------------------------------------------*/
    let isMember = false;
    if (resolvedGroupId > 0) {
      try {
        const member = await env.DB.prepare(
          `SELECT 1 FROM group_members WHERE group_id=? AND user_id=? LIMIT 1`
        )
          .bind(resolvedGroupId, user_id)
          .first();
        if (member) isMember = true;
      } catch (_) {}

      if (!isMember) {
        try {
          const groupOwner = await env.DB.prepare(
            `SELECT admin_id FROM groups WHERE id=? LIMIT 1`
          )
            .bind(resolvedGroupId)
            .first<any>();
          if (groupOwner && toNum(groupOwner.admin_id, 0) === user_id) {
            isMember = true;
          }
        } catch (_) {}
      }
    } else {
      isMember = true;
    }

    let isPublicGroup = false;
    try {
      const gRow = await env.DB.prepare(`SELECT type FROM groups WHERE id=? LIMIT 1`).bind(resolvedGroupId).first<any>();
      if (gRow && String(gRow.type || '').toLowerCase() === 'public') {
        isPublicGroup = true;
      }
    } catch (_) {}
    if (post.type === 'public' || post.visibility === 'public') {
      isPublicGroup = true;
    }

    // Allow sharing if member or admin or if user is creator or if group is public
    if (!isMember && toNum(post.user_id, 0) !== user_id && !isPublicGroup) {
      return json({ success: false, error: "User is not a member of this group" }, 403);
    }

    /* --------------------------------------------------
       Insert share into group_post_shares
    ---------------------------------------------------*/
    const insert = await env.DB.prepare(
      `INSERT INTO group_post_shares (user_id, group_post_id, group_id, destination, message)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(user_id, post_id, resolvedGroupId, destination, message)
      .run();

    const share_id = toNum(insert.meta?.last_row_id, Date.now());

    /* --------------------------------------------------
       Notification
    ---------------------------------------------------*/
    const postOwnerId = toNum(post?.user_id, 0);
    if (postOwnerId && postOwnerId !== user_id) {
      try {
        await createNotification(
          env,
          postOwnerId,
          user_id,
          "share",
          "group_post",
          post_id,
          `group_post:${post_id}:share`,
          "shared your group post"
        );
      } catch (_) {}
    }

    /* --------------------------------------------------
       Get updated share count from group_post_shares
    ---------------------------------------------------*/
    let shares_count = 1;
    try {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) as c FROM group_post_shares WHERE group_post_id=?`
      )
        .bind(post_id)
        .first<any>();
      shares_count = toNum(row?.c, 1);
    } catch (_) {}

    /* --------------------------------------------------
       Lookup sharing user details
    ---------------------------------------------------*/
    let sharingUser: any = null;
    try {
      sharingUser = await env.DB.prepare(
        `SELECT id, name, username, profile_image_url, is_verified FROM users WHERE id=? LIMIT 1`
      )
        .bind(user_id)
        .first<any>();
    } catch (_) {}

    /* --------------------------------------------------
       Lookup original post author details
    ---------------------------------------------------*/
    let postAuthor: any = null;
    if (postOwnerId > 0) {
      try {
        postAuthor = await env.DB.prepare(
          `SELECT id, name, username, profile_image_url, is_verified FROM users WHERE id=? LIMIT 1`
        )
          .bind(postOwnerId)
          .first<any>();
      } catch (_) {}
    }

    const groupName = post.group_name || 'Group';
    const groupImage = post.group_image || '';
    const isGroupVerified = Boolean(post.is_group_verified);

    /* --------------------------------------------------
       Construct created shared post object for Feed / Profile
    ---------------------------------------------------*/
    const resolvedSharedPost = {
      ...post,
      id: post.id || post_id,
      post_id: post.id || post_id,
      group_id: resolvedGroupId,
      group_name: groupName,
      group_image: groupImage,
      is_group_verified: isGroupVerified,
      group: {
        id: resolvedGroupId,
        name: groupName,
        profile_image: groupImage,
        is_verified: isGroupVerified,
      },
      author: postAuthor ? {
        id: postAuthor.id,
        name: postAuthor.name || postAuthor.username || 'User',
        username: postAuthor.username || '',
        profile_image_url: postAuthor.profile_image_url || '',
        avatar_url: postAuthor.profile_image_url || '',
        is_verified: Boolean(postAuthor.is_verified),
      } : (post.author || {
        id: post.user_id,
        name: post.name || post.username || 'User',
        username: post.username || '',
        profile_image_url: post.profile_image_url || '',
      }),
      user: postAuthor || post.user,
      source: 'group_post',
      item_type: 'group_post',
    };

    const createdSharedPost = {
      id: share_id,
      post_id: share_id,
      user_id: user_id,
      author: sharingUser ? {
        id: sharingUser.id,
        name: sharingUser.name || sharingUser.username || 'User',
        username: sharingUser.username || '',
        profile_image_url: sharingUser.profile_image_url || '',
        avatar_url: sharingUser.profile_image_url || '',
        is_verified: Boolean(sharingUser.is_verified),
      } : {
        id: user_id,
        name: 'User',
        username: 'user',
        profile_image_url: '',
      },
      user: sharingUser,
      content: message || '',
      description: message || '',
      message: message || '',
      destination: destination,
      item_type: 'group_post_share',
      source: 'group_post_share',
      type: 'share',
      post_type: 'share',
      shared_post_id: post_id,
      group_id: resolvedGroupId,
      group_name: groupName,
      group_image: groupImage,
      is_group_verified: isGroupVerified,
      shared_post: resolvedSharedPost,
      created_at: new Date().toISOString(),
      shares: 0,
      shares_count: 0,
      likes_count: 0,
      reactions_count: 0,
      comments_count: 0,
      visibility: 'public',
    };

    /* --------------------------------------------------
       If shared to another group: destination === 'group'
    ---------------------------------------------------*/
    let newGroupPostId = 0;
    const targetGroupId = toNum(body.target_group_id || (destination === 'group' ? body.group_id : 0), 0);
    if (destination === 'group' && targetGroupId > 0) {
      try {
        const metaJson = JSON.stringify([{
          kind: 'shared_post',
          type: 'shared_post',
          shared_post_id: post_id,
          shared_post: resolvedSharedPost,
        }]);

        const insGroupPost = await env.DB.prepare(`
          INSERT INTO group_posts (
            group_id, user_id, content, media_meta, visibility, created_at, is_deleted
          ) VALUES (?, ?, ?, ?, 'public', datetime('now'), 0)
        `)
          .bind(targetGroupId, user_id, message || '', metaJson)
          .run();

        newGroupPostId = toNum(insGroupPost.meta?.last_row_id, Date.now());
      } catch (errGP) {
        console.error("Failed to insert group post for cross-group share:", errGP);
      }
    }

    return json({
      success: true,
      share_id,
      post_id,
      group_id: resolvedGroupId,
      shares: shares_count,
      shares_count,
      share_count: shares_count,
      destination,
      post: createdSharedPost,
      shared_post: resolvedSharedPost,
      new_group_post_id: newGroupPostId || undefined,
    });
  } catch (err: any) {
    return json({ success: false, error: err?.message || "Server error" }, 500);
  }
};
