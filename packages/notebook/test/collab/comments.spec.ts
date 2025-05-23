// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { CommentSystem, ICommentSystem, CommentStatus, CommentPriority, ICommentUser, ICommentThread, IComment, ICommentReply, CommentChangeType } from '@jupyter-notebook/notebook/lib/collab/comments';
import { NotebookModel } from '@jupyter-notebook/notebook';
import * as Y from 'yjs';
import { YNotebookProvider } from '@jupyter-notebook/notebook/lib/collab/yprovider';

// Mock user data for testing
const testUser1: ICommentUser = {
  id: 'user1',
  displayName: 'Test User 1',
  avatarUrl: 'https://example.com/avatar1.png',
  email: 'user1@example.com'
};

const testUser2: ICommentUser = {
  id: 'user2',
  displayName: 'Test User 2',
  avatarUrl: 'https://example.com/avatar2.png',
  email: 'user2@example.com'
};

// Helper function to create a comment system for testing
function createCommentSystem(): { commentSystem: ICommentSystem; ydoc: Y.Doc; model: NotebookModel } {
  const ydoc = new Y.Doc();
  const provider = new YNotebookProvider(ydoc);
  
  const model = new NotebookModel({
    collaborative: true,
    yjsProvider: provider
  });
  
  const commentSystem = new CommentSystem(model, ydoc);
  
  return { commentSystem, ydoc, model };
}

// Helper function to create a second comment system with the same Yjs document
function createSecondClient(ydoc: Y.Doc): { commentSystem: ICommentSystem; model: NotebookModel } {
  const provider = new YNotebookProvider(ydoc);
  
  const model = new NotebookModel({
    collaborative: true,
    yjsProvider: provider
  });
  
  const commentSystem = new CommentSystem(model, ydoc);
  
  return { commentSystem, model };
}

// Helper function to simulate network synchronization between clients
function syncClients(sourceDoc: Y.Doc, targetDoc: Y.Doc): void {
  const update = Y.encodeStateAsUpdate(sourceDoc);
  Y.applyUpdate(targetDoc, update);
}

describe('CommentSystem', () => {
  
  describe('Thread Management', () => {
    it('should create a new comment thread', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread(
        'cell1',
        'This is a test comment',
        testUser1
      );
      
      expect(thread).toBeDefined();
      expect(thread.id).toBeDefined();
      expect(thread.cellId).toBe('cell1');
      expect(thread.comments.length).toBe(1);
      expect(thread.comments[0].content).toBe('This is a test comment');
      expect(thread.comments[0].author).toEqual(testUser1);
      expect(thread.comments[0].status).toBe(CommentStatus.Open);
    });
    
    it('should create a thread with a specific range', () => {
      const { commentSystem } = createCommentSystem();
      
      const range = { start: 10, end: 20 };
      const thread = commentSystem.createThread(
        'cell1',
        'Comment on a specific range',
        testUser1,
        range
      );
      
      expect(thread.range).toEqual(range);
    });
    
    it('should retrieve all threads', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Comment 1', testUser1);
      commentSystem.createThread('cell2', 'Comment 2', testUser1);
      
      const threads = commentSystem.getThreads();
      expect(threads.length).toBe(2);
    });
    
    it('should retrieve threads for a specific cell', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Comment 1', testUser1);
      commentSystem.createThread('cell1', 'Comment 2', testUser1);
      commentSystem.createThread('cell2', 'Comment 3', testUser1);
      
      const threadsForCell1 = commentSystem.getThreadsForCell('cell1');
      expect(threadsForCell1.length).toBe(2);
      
      const threadsForCell2 = commentSystem.getThreadsForCell('cell2');
      expect(threadsForCell2.length).toBe(1);
    });
    
    it('should retrieve a specific thread by ID', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread1 = commentSystem.createThread('cell1', 'Comment 1', testUser1);
      commentSystem.createThread('cell2', 'Comment 2', testUser1);
      
      const retrievedThread = commentSystem.getThread(thread1.id);
      expect(retrievedThread).toBeDefined();
      expect(retrievedThread?.id).toBe(thread1.id);
    });
    
    it('should delete a thread', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment to delete', testUser1);
      expect(commentSystem.getThreads().length).toBe(1);
      
      commentSystem.deleteThread(thread.id);
      expect(commentSystem.getThreads().length).toBe(0);
    });
  });
  
  describe('Comment Management', () => {
    it('should add a comment to an existing thread', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Initial comment', testUser1);
      const comment = commentSystem.addComment(
        thread.id,
        'Second comment',
        testUser2,
        CommentPriority.High
      );
      
      expect(comment).toBeDefined();
      expect(comment?.content).toBe('Second comment');
      expect(comment?.author).toEqual(testUser2);
      expect(comment?.priority).toBe(CommentPriority.High);
      
      // Verify the thread has both comments
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments.length).toBe(2);
    });
    
    it('should update an existing comment', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment to update', testUser1);
      const commentId = thread.comments[0].id;
      
      const updatedComment = commentSystem.updateComment(
        thread.id,
        commentId,
        'Updated comment content',
        CommentPriority.High
      );
      
      expect(updatedComment).toBeDefined();
      expect(updatedComment?.content).toBe('Updated comment content');
      expect(updatedComment?.priority).toBe(CommentPriority.High);
      expect(updatedComment?.edited).toBe(true);
      
      // Verify the thread has the updated comment
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].content).toBe('Updated comment content');
    });
    
    it('should resolve a comment', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment to resolve', testUser1);
      const commentId = thread.comments[0].id;
      
      const resolvedComment = commentSystem.resolveComment(thread.id, commentId, testUser2);
      
      expect(resolvedComment).toBeDefined();
      expect(resolvedComment?.status).toBe(CommentStatus.Resolved);
      expect(resolvedComment?.resolvedBy).toEqual(testUser2);
      expect(resolvedComment?.resolvedAt).toBeDefined();
      
      // Verify the thread has the resolved comment
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].status).toBe(CommentStatus.Resolved);
    });
    
    it('should reopen a resolved comment', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment to resolve and reopen', testUser1);
      const commentId = thread.comments[0].id;
      
      commentSystem.resolveComment(thread.id, commentId, testUser2);
      const reopenedComment = commentSystem.reopenComment(thread.id, commentId);
      
      expect(reopenedComment).toBeDefined();
      expect(reopenedComment?.status).toBe(CommentStatus.Open);
      expect(reopenedComment?.resolvedBy).toBeUndefined();
      expect(reopenedComment?.resolvedAt).toBeUndefined();
      
      // Verify the thread has the reopened comment
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].status).toBe(CommentStatus.Open);
    });
    
    it('should archive a comment', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment to archive', testUser1);
      const commentId = thread.comments[0].id;
      
      const archivedComment = commentSystem.archiveComment(thread.id, commentId);
      
      expect(archivedComment).toBeDefined();
      expect(archivedComment?.status).toBe(CommentStatus.Archived);
      
      // Verify the thread has the archived comment
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].status).toBe(CommentStatus.Archived);
    });
    
    it('should delete a comment', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Initial comment', testUser1);
      const comment = commentSystem.addComment(thread.id, 'Comment to delete', testUser2);
      
      expect(commentSystem.getThread(thread.id)?.comments.length).toBe(2);
      
      commentSystem.deleteComment(thread.id, comment!.id);
      
      // Verify the comment was deleted
      expect(commentSystem.getThread(thread.id)?.comments.length).toBe(1);
    });
    
    it('should delete the thread when the last comment is deleted', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Only comment', testUser1);
      const commentId = thread.comments[0].id;
      
      commentSystem.deleteComment(thread.id, commentId);
      
      // Verify the thread was deleted
      expect(commentSystem.getThread(thread.id)).toBeUndefined();
    });
  });
  
  describe('Reply Management', () => {
    it('should add a reply to a comment', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment with reply', testUser1);
      const commentId = thread.comments[0].id;
      
      const reply = commentSystem.addReply(
        thread.id,
        commentId,
        'This is a reply',
        testUser2
      );
      
      expect(reply).toBeDefined();
      expect(reply?.content).toBe('This is a reply');
      expect(reply?.author).toEqual(testUser2);
      
      // Verify the comment has the reply
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].replies.length).toBe(1);
      expect(updatedThread?.comments[0].replies[0].content).toBe('This is a reply');
    });
    
    it('should update a reply', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment with reply', testUser1);
      const commentId = thread.comments[0].id;
      
      const reply = commentSystem.addReply(thread.id, commentId, 'Reply to update', testUser2);
      const updatedReply = commentSystem.updateReply(
        thread.id,
        commentId,
        reply!.id,
        'Updated reply content'
      );
      
      expect(updatedReply).toBeDefined();
      expect(updatedReply?.content).toBe('Updated reply content');
      expect(updatedReply?.edited).toBe(true);
      
      // Verify the comment has the updated reply
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].replies[0].content).toBe('Updated reply content');
    });
    
    it('should delete a reply', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment with reply', testUser1);
      const commentId = thread.comments[0].id;
      
      const reply = commentSystem.addReply(thread.id, commentId, 'Reply to delete', testUser2);
      
      expect(commentSystem.getThread(thread.id)?.comments[0].replies.length).toBe(1);
      
      commentSystem.deleteReply(thread.id, commentId, reply!.id);
      
      // Verify the reply was deleted
      expect(commentSystem.getThread(thread.id)?.comments[0].replies.length).toBe(0);
    });
  });
  
  describe('Notification Management', () => {
    it('should create notifications for new comments', () => {
      const { commentSystem } = createCommentSystem();
      
      // Create a thread which should generate a notification
      commentSystem.createThread('cell1', 'Comment with notification', testUser1);
      
      const notifications = commentSystem.getNotifications();
      expect(notifications.length).toBe(1);
      expect(notifications[0].type).toBe('new-comment');
      expect(notifications[0].userId).toBe(testUser1.id);
    });
    
    it('should create notifications for replies', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment with reply', testUser1);
      const commentId = thread.comments[0].id;
      
      // Add a reply which should generate a notification
      commentSystem.addReply(thread.id, commentId, 'Reply with notification', testUser2);
      
      const notifications = commentSystem.getNotifications();
      expect(notifications.length).toBe(2); // One for the comment, one for the reply
      expect(notifications[1].type).toBe('new-reply');
      expect(notifications[1].userId).toBe(testUser2.id);
    });
    
    it('should create notifications for resolved comments', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment to resolve', testUser1);
      const commentId = thread.comments[0].id;
      
      // Resolve the comment which should generate a notification
      commentSystem.resolveComment(thread.id, commentId, testUser2);
      
      const notifications = commentSystem.getNotifications();
      expect(notifications.length).toBe(2); // One for the comment, one for resolving
      expect(notifications[1].type).toBe('resolved');
      expect(notifications[1].userId).toBe(testUser2.id);
    });
    
    it('should create notifications for mentions', () => {
      const { commentSystem } = createCommentSystem();
      
      // Create a comment with a mention
      commentSystem.createThread('cell1', 'Comment mentioning @user2', testUser1);
      
      const notifications = commentSystem.getNotifications();
      expect(notifications.length).toBeGreaterThanOrEqual(1);
      
      // Check if there's a mention notification
      const mentionNotifications = notifications.filter(n => n.type === 'mention');
      expect(mentionNotifications.length).toBeGreaterThanOrEqual(1);
    });
    
    it('should mark notifications as read', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Comment with notification', testUser1);
      
      const notifications = commentSystem.getNotifications();
      expect(notifications[0].read).toBe(false);
      
      commentSystem.markNotificationAsRead(notifications[0].id);
      
      const updatedNotifications = commentSystem.getNotifications();
      expect(updatedNotifications[0].read).toBe(true);
    });
    
    it('should mark all notifications as read', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'First comment', testUser1);
      commentSystem.createThread('cell2', 'Second comment', testUser1);
      
      expect(commentSystem.getUnreadNotifications().length).toBe(2);
      
      commentSystem.markAllNotificationsAsRead();
      
      expect(commentSystem.getUnreadNotifications().length).toBe(0);
    });
  });
  
  describe('Filtering and Searching', () => {
    it('should filter comments by status', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread1 = commentSystem.createThread('cell1', 'Open comment', testUser1);
      const thread2 = commentSystem.createThread('cell2', 'Comment to resolve', testUser1);
      
      commentSystem.resolveComment(thread2.id, thread2.comments[0].id, testUser2);
      
      const openComments = commentSystem.filterComments({ status: CommentStatus.Open });
      expect(openComments.length).toBe(1);
      expect(openComments[0].id).toBe(thread1.id);
      
      const resolvedComments = commentSystem.filterComments({ status: CommentStatus.Resolved });
      expect(resolvedComments.length).toBe(1);
      expect(resolvedComments[0].id).toBe(thread2.id);
    });
    
    it('should filter comments by author', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Comment by user1', testUser1);
      const thread2 = commentSystem.createThread('cell2', 'Initial comment', testUser1);
      
      commentSystem.addComment(thread2.id, 'Comment by user2', testUser2);
      
      const user1Comments = commentSystem.filterComments({ authorId: testUser1.id });
      expect(user1Comments.length).toBe(2);
      
      const user2Comments = commentSystem.filterComments({ authorId: testUser2.id });
      expect(user2Comments.length).toBe(1);
      expect(user2Comments[0].id).toBe(thread2.id);
    });
    
    it('should filter comments by cell ID', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Comment on cell1', testUser1);
      commentSystem.createThread('cell2', 'Comment on cell2', testUser1);
      commentSystem.createThread('cell1', 'Another comment on cell1', testUser1);
      
      const cell1Comments = commentSystem.filterComments({ cellId: 'cell1' });
      expect(cell1Comments.length).toBe(2);
      
      const cell2Comments = commentSystem.filterComments({ cellId: 'cell2' });
      expect(cell2Comments.length).toBe(1);
    });
    
    it('should filter comments by priority', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Low priority comment', testUser1, undefined, CommentPriority.Low);
      commentSystem.createThread('cell2', 'Medium priority comment', testUser1, undefined, CommentPriority.Medium);
      commentSystem.createThread('cell3', 'High priority comment', testUser1, undefined, CommentPriority.High);
      
      const highPriorityComments = commentSystem.filterComments({ priority: CommentPriority.High });
      expect(highPriorityComments.length).toBe(1);
      expect(highPriorityComments[0].comments[0].priority).toBe(CommentPriority.High);
    });
    
    it('should search comments by text content', () => {
      const { commentSystem } = createCommentSystem();
      
      commentSystem.createThread('cell1', 'Comment about Python', testUser1);
      commentSystem.createThread('cell2', 'Comment about JavaScript', testUser1);
      
      const pythonComments = commentSystem.searchComments('Python');
      expect(pythonComments.length).toBe(1);
      expect(pythonComments[0].comments[0].content).toBe('Comment about Python');
      
      const jsComments = commentSystem.searchComments('JavaScript');
      expect(jsComments.length).toBe(1);
      expect(jsComments[0].comments[0].content).toBe('Comment about JavaScript');
    });
    
    it('should search in replies as well', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Main comment', testUser1);
      commentSystem.addReply(thread.id, thread.comments[0].id, 'Reply mentioning Python', testUser2);
      
      const pythonComments = commentSystem.searchComments('Python');
      expect(pythonComments.length).toBe(1);
    });
  });
  
  describe('Statistics', () => {
    it('should calculate comment statistics', () => {
      const { commentSystem } = createCommentSystem();
      
      // Create various comments with different statuses
      const thread1 = commentSystem.createThread('cell1', 'Open comment 1', testUser1);
      const thread2 = commentSystem.createThread('cell2', 'Open comment 2', testUser1);
      const thread3 = commentSystem.createThread('cell3', 'Comment to resolve', testUser1);
      
      // Add replies
      commentSystem.addReply(thread1.id, thread1.comments[0].id, 'Reply 1', testUser2);
      commentSystem.addReply(thread1.id, thread1.comments[0].id, 'Reply 2', testUser2);
      
      // Resolve one comment
      commentSystem.resolveComment(thread3.id, thread3.comments[0].id, testUser2);
      
      // Archive one comment
      commentSystem.archiveComment(thread2.id, thread2.comments[0].id);
      
      const stats = commentSystem.getStatistics();
      
      expect(stats.totalThreads).toBe(3);
      expect(stats.totalComments).toBe(3);
      expect(stats.totalReplies).toBe(2);
      expect(stats.openComments).toBe(1);
      expect(stats.resolvedComments).toBe(1);
      expect(stats.archivedComments).toBe(1);
    });
  });
  
  describe('Multi-client Synchronization', () => {
    it('should synchronize comment threads between clients', () => {
      // Create two clients with the same Yjs document
      const { commentSystem: client1, ydoc } = createCommentSystem();
      const { commentSystem: client2 } = createSecondClient(ydoc);
      
      // Client 1 creates a thread
      const thread = client1.createThread('cell1', 'Collaborative comment', testUser1);
      
      // Verify that client 2 sees the thread
      const threadsInClient2 = client2.getThreads();
      expect(threadsInClient2.length).toBe(1);
      expect(threadsInClient2[0].id).toBe(thread.id);
      expect(threadsInClient2[0].comments[0].content).toBe('Collaborative comment');
    });
    
    it('should synchronize comment updates between clients', () => {
      // Create two clients with the same Yjs document
      const { commentSystem: client1, ydoc } = createCommentSystem();
      const { commentSystem: client2 } = createSecondClient(ydoc);
      
      // Client 1 creates a thread
      const thread = client1.createThread('cell1', 'Comment to update', testUser1);
      const commentId = thread.comments[0].id;
      
      // Client 2 updates the comment
      client2.updateComment(thread.id, commentId, 'Updated by client 2');
      
      // Verify that client 1 sees the update
      const updatedThreadInClient1 = client1.getThread(thread.id);
      expect(updatedThreadInClient1?.comments[0].content).toBe('Updated by client 2');
    });
    
    it('should synchronize comment resolution between clients', () => {
      // Create two clients with the same Yjs document
      const { commentSystem: client1, ydoc } = createCommentSystem();
      const { commentSystem: client2 } = createSecondClient(ydoc);
      
      // Client 1 creates a thread
      const thread = client1.createThread('cell1', 'Comment to resolve', testUser1);
      const commentId = thread.comments[0].id;
      
      // Client 2 resolves the comment
      client2.resolveComment(thread.id, commentId, testUser2);
      
      // Verify that client 1 sees the resolution
      const resolvedThreadInClient1 = client1.getThread(thread.id);
      expect(resolvedThreadInClient1?.comments[0].status).toBe(CommentStatus.Resolved);
      expect(resolvedThreadInClient1?.comments[0].resolvedBy).toEqual(testUser2);
    });
    
    it('should synchronize replies between clients', () => {
      // Create two clients with the same Yjs document
      const { commentSystem: client1, ydoc } = createCommentSystem();
      const { commentSystem: client2 } = createSecondClient(ydoc);
      
      // Client 1 creates a thread
      const thread = client1.createThread('cell1', 'Comment for reply', testUser1);
      const commentId = thread.comments[0].id;
      
      // Client 2 adds a reply
      client2.addReply(thread.id, commentId, 'Reply from client 2', testUser2);
      
      // Verify that client 1 sees the reply
      const threadWithReplyInClient1 = client1.getThread(thread.id);
      expect(threadWithReplyInClient1?.comments[0].replies.length).toBe(1);
      expect(threadWithReplyInClient1?.comments[0].replies[0].content).toBe('Reply from client 2');
    });
    
    it('should synchronize thread deletion between clients', () => {
      // Create two clients with the same Yjs document
      const { commentSystem: client1, ydoc } = createCommentSystem();
      const { commentSystem: client2 } = createSecondClient(ydoc);
      
      // Client 1 creates a thread
      const thread = client1.createThread('cell1', 'Comment to delete', testUser1);
      
      // Verify that client 2 sees the thread
      expect(client2.getThreads().length).toBe(1);
      
      // Client 1 deletes the thread
      client1.deleteThread(thread.id);
      
      // Verify that client 2 sees the deletion
      expect(client2.getThreads().length).toBe(0);
    });
    
    it('should handle concurrent comment creation', () => {
      // Create two clients with separate Yjs documents (to simulate network partition)
      const { commentSystem: client1, ydoc: ydoc1 } = createCommentSystem();
      const { commentSystem: client2, ydoc: ydoc2 } = createCommentSystem();
      
      // Initial sync to ensure both documents are in the same state
      syncClients(ydoc1, ydoc2);
      syncClients(ydoc2, ydoc1);
      
      // Client 1 creates a thread
      client1.createThread('cell1', 'Comment from client 1', testUser1);
      
      // Client 2 creates a thread (without seeing client 1's thread)
      client2.createThread('cell1', 'Comment from client 2', testUser2);
      
      // Sync the clients
      syncClients(ydoc1, ydoc2);
      syncClients(ydoc2, ydoc1);
      
      // Verify that both clients see both threads
      expect(client1.getThreads().length).toBe(2);
      expect(client2.getThreads().length).toBe(2);
      
      // Verify the content of the threads
      const threadsInClient1 = client1.getThreads();
      const commentContents = threadsInClient1.map(t => t.comments[0].content);
      expect(commentContents).toContain('Comment from client 1');
      expect(commentContents).toContain('Comment from client 2');
    });
  });
  
  describe('Error Handling and Edge Cases', () => {
    it('should handle non-existent thread IDs gracefully', () => {
      const { commentSystem } = createCommentSystem();
      
      // Try to get a non-existent thread
      const thread = commentSystem.getThread('non-existent-id');
      expect(thread).toBeUndefined();
      
      // Try to add a comment to a non-existent thread
      const comment = commentSystem.addComment('non-existent-id', 'Comment', testUser1);
      expect(comment).toBeUndefined();
      
      // Try to delete a non-existent thread
      expect(() => {
        commentSystem.deleteThread('non-existent-id');
      }).not.toThrow();
    });
    
    it('should handle non-existent comment IDs gracefully', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment', testUser1);
      
      // Try to update a non-existent comment
      const updatedComment = commentSystem.updateComment(thread.id, 'non-existent-id', 'Updated');
      expect(updatedComment).toBeUndefined();
      
      // Try to resolve a non-existent comment
      const resolvedComment = commentSystem.resolveComment(thread.id, 'non-existent-id', testUser2);
      expect(resolvedComment).toBeUndefined();
      
      // Try to delete a non-existent comment
      expect(() => {
        commentSystem.deleteComment(thread.id, 'non-existent-id');
      }).not.toThrow();
    });
    
    it('should handle non-existent reply IDs gracefully', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment', testUser1);
      const commentId = thread.comments[0].id;
      
      // Try to update a non-existent reply
      const updatedReply = commentSystem.updateReply(thread.id, commentId, 'non-existent-id', 'Updated');
      expect(updatedReply).toBeUndefined();
      
      // Try to delete a non-existent reply
      expect(() => {
        commentSystem.deleteReply(thread.id, commentId, 'non-existent-id');
      }).not.toThrow();
    });
    
    it('should handle empty or invalid input gracefully', () => {
      const { commentSystem } = createCommentSystem();
      
      // Create a thread with empty content
      const thread = commentSystem.createThread('cell1', '', testUser1);
      expect(thread).toBeDefined();
      expect(thread.comments[0].content).toBe('');
      
      // Update a comment with empty content
      const commentId = thread.comments[0].id;
      const updatedComment = commentSystem.updateComment(thread.id, commentId, '');
      expect(updatedComment).toBeDefined();
      expect(updatedComment?.content).toBe('');
    });
    
    it('should handle disposal correctly', () => {
      const { commentSystem } = createCommentSystem();
      
      // Create some data
      commentSystem.createThread('cell1', 'Comment', testUser1);
      
      // Dispose the comment system
      commentSystem.dispose();
      
      // Verify that the comment system is disposed
      // Note: This is a bit tricky to test directly since dispose() is mostly about cleaning up resources
      // We're just ensuring it doesn't throw an error
      expect(() => {
        commentSystem.dispose();
      }).not.toThrow();
    });
  });
  
  describe('Change Events', () => {
    it('should emit change events when threads are created', () => {
      const { commentSystem } = createCommentSystem();
      
      // Set up a listener for change events
      const changeHandler = jest.fn();
      commentSystem.changed.connect(changeHandler);
      
      // Create a thread
      const thread = commentSystem.createThread('cell1', 'Comment', testUser1);
      
      // Verify that the change event was emitted
      expect(changeHandler).toHaveBeenCalled();
      expect(changeHandler.mock.calls[0][1].type).toBe(CommentChangeType.ThreadAdded);
      expect(changeHandler.mock.calls[0][1].threadId).toBe(thread.id);
    });
    
    it('should emit change events when comments are updated', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment', testUser1);
      const commentId = thread.comments[0].id;
      
      // Set up a listener for change events
      const changeHandler = jest.fn();
      commentSystem.changed.connect(changeHandler);
      
      // Update the comment
      commentSystem.updateComment(thread.id, commentId, 'Updated comment');
      
      // Verify that the change event was emitted
      expect(changeHandler).toHaveBeenCalled();
      expect(changeHandler.mock.calls[0][1].type).toBe(CommentChangeType.CommentUpdated);
      expect(changeHandler.mock.calls[0][1].threadId).toBe(thread.id);
      expect(changeHandler.mock.calls[0][1].commentId).toBe(commentId);
    });
    
    it('should emit change events when replies are added', () => {
      const { commentSystem } = createCommentSystem();
      
      const thread = commentSystem.createThread('cell1', 'Comment', testUser1);
      const commentId = thread.comments[0].id;
      
      // Set up a listener for change events
      const changeHandler = jest.fn();
      commentSystem.changed.connect(changeHandler);
      
      // Add a reply
      const reply = commentSystem.addReply(thread.id, commentId, 'Reply', testUser2);
      
      // Verify that the change event was emitted
      expect(changeHandler).toHaveBeenCalled();
      expect(changeHandler.mock.calls[0][1].type).toBe(CommentChangeType.ReplyAdded);
      expect(changeHandler.mock.calls[0][1].threadId).toBe(thread.id);
      expect(changeHandler.mock.calls[0][1].commentId).toBe(commentId);
      expect(changeHandler.mock.calls[0][1].replyId).toBe(reply?.id);
    });
    
    it('should emit notification events', () => {
      const { commentSystem } = createCommentSystem();
      
      // Set up a listener for notification events
      const notificationHandler = jest.fn();
      commentSystem.notificationsChanged.connect(notificationHandler);
      
      // Create a thread (which should generate a notification)
      commentSystem.createThread('cell1', 'Comment', testUser1);
      
      // Verify that the notification event was emitted
      expect(notificationHandler).toHaveBeenCalled();
      expect(notificationHandler.mock.calls[0][1].length).toBeGreaterThan(0);
    });
  });
});