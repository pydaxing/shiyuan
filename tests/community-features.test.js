import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';
import { baseParse } from '@vue/compiler-dom';
import { COMMUNITY_COMMENTS_ENABLED } from '../src/domain/community-features.js';

const source = readFileSync(new URL('../src/components/CommunityView.vue', import.meta.url), 'utf8');

test('all comment controls are retained beneath a single disabled feature gate, with no report affordance', () => {
  assert.equal(COMMUNITY_COMMENTS_ENABLED, false);
  let controls = 0;
  function visit(node, hidden = false) {
    if (node.type !== 1) return;
    const gated = hidden || node.props.some(prop => prop.name === 'if' && prop.exp?.content === 'COMMUNITY_COMMENTS_ENABLED');
    if (node.tag === 'CommentItem' || node.props.some(prop => prop.name === 'class' && /comment-composer|comment-thread/.test(prop.value?.content))) {
      controls += 1;
      assert.equal(gated, true);
    }
    node.children.forEach(child => visit(child, gated));
  }
  const template = parse(source).descriptor.template.content;
  baseParse(template).children.forEach(node => visit(node));
  assert.ok(controls >= 3);
  assert.doesNotMatch(template, /举报内容|reportPost/);
  assert.match(template, /<FoodDetailSheet[^>]*:share-card="friendCard"/);
  assert.match(template, /imported\(current\) \? '已加入' : addingPosts.includes\(current.id\) \? '加入中' : '加入菜单'/);
});

test('disabled comments are neither fetched nor overwritten, and write/pagination entry points are guarded', () => {
  assert.match(source, /readCommunityPost\(post.id, \{ includeComments: COMMUNITY_COMMENTS_ENABLED \}\)/);
  assert.match(source, /peekCommunityPost\(post.id, \{ includeComments: COMMUNITY_COMMENTS_ENABLED \}\)/);
  assert.match(source, /mergeCloudCommunity\(\{ posts: \[cached.post\], comments: COMMUNITY_COMMENTS_ENABLED \? cached.comments : \[\] \}\)/);
  assert.match(source, /mergeCloudCommunity\(\{ posts: \[result.post\], comments: COMMUNITY_COMMENTS_ENABLED \? result.comments : \[\] \}\)/);
  assert.match(source, /async function loadComments\(\) \{\s*if \(!COMMUNITY_COMMENTS_ENABLED/);
  assert.match(source, /async function send\(\) \{\s*if \(!COMMUNITY_COMMENTS_ENABLED/);
  assert.match(source, /await addComment/);
});
