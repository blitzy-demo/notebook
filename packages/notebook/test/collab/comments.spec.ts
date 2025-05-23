// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  CommentSystem,
  ICommentSystem,
  CommentStatus,
  CommentPriority,
  ICommentUser,
  ICommentThread,
  IComment,
  ICommentReply,
  CommentChangeType
} from '../../src/collab/comments';

import { INotebookModel } from '../../src/model';
import * as Y from 'yjs';

/**
 * Mock notebook model for testing
 */
class MockNotebookModel implements Partial<INotebookModel> {
  constructor() {}
}

/**
 * Helper function to create a mock user for testing
 */
function createMockUser(id: string, name: string, email?: string, avatarUrl?: string): ICommentUser {
  return {
    id,
    displayName: name,
    email,
    avatarUrl
  };
}

/**
 * Helper function to create a comment system for testing
 */
function createCommentSystem(): { ydoc: Y.Doc; commentSystem: ICommentSystem } {
  const ydoc = new Y.Doc();
  const notebookModel = new MockNotebookModel() as INotebookModel;
  const commentSystem = new CommentSystem(notebookModel, ydoc);
  return { ydoc, commentSystem };
}

/**
 * Helper function to connect two Yjs documents
 */
function connectYjsDocs(doc1: Y.Doc, doc2: Y.Doc): void {
  // Create update handlers to sync the documents
  const doc1UpdateHandler = (update: Uint8Array) => {
    Y.applyUpdate(doc2, update);
  };
  
  const doc2UpdateHandler = (update: Uint8Array) => {
    Y.applyUpdate(doc1, update);
  };
  
  // Set up event listeners
  doc1.on('update', doc1UpdateHandler);
  doc2.on('update', doc2UpdateHandler);
  
  // Sync the initial state
  doc1UpdateHandler(Y.encodeStateAsUpdate(doc1));
}

describe('CommentSystem', () => {
  describe('constructor', () => {
    it('should create a comment system with the correct initial state', () => {
      const { commentSystem } = createCommentSystem();
      
      expect(commentSystem.getThreads()).toHaveLength(0);
      expect(commentSystem.getNotifications()).toHaveLength(0);
    });
  });
  
  describe('thread management', () => {
    it('should create a new comment thread', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      const cellId = 'cell1';
      const content = 'This is a comment';
      
      const thread = commentSystem.createThread(cellId, content, user);
      
      expect(thread).toBeDefined();
      expect(thread.id).toBeDefined();
      expect(thread.cellId).toBe(cellId);
      expect(thread.comments).toHaveLength(1);
      expect(thread.comments[0].content).toBe(content);
      expect(thread.comments[0].author).toEqual(user);
      expect(thread.comments[0].status).toBe(CommentStatus.Open);
      
      // Verify the thread is in the system
      const threads = commentSystem.getThreads();
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe(thread.id);
    });
    
    it('should create a thread with a range', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      const cellId = 'cell1';
      const content = 'This is a comment';
      const range = { start: 10, end: 20 };
      
      const thread = commentSystem.createThread(cellId, content, user, range);
      
      expect(thread.range).toEqual(range);
    });
    
    it('should delete a thread', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      const cellId = 'cell1';
      
      // Create a thread
      const thread = commentSystem.createThread(cellId, 'Comment', user);
      expect(commentSystem.getThreads()).toHaveLength(1);
      
      // Delete the thread
      commentSystem.deleteThread(thread.id);
      
      // Verify the thread is deleted
      expect(commentSystem.getThreads()).toHaveLength(0);
      expect(commentSystem.getThread(thread.id)).toBeUndefined();
    });
    
    it('should get threads for a specific cell', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create threads for different cells
      commentSystem.createThread('cell1', 'Comment 1', user);
      commentSystem.createThread('cell2', 'Comment 2', user);
      commentSystem.createThread('cell1', 'Comment 3', user);
      
      // Get threads for cell1
      const cell1Threads = commentSystem.getThreadsForCell('cell1');
      
      expect(cell1Threads).toHaveLength(2);
      expect(cell1Threads.every(thread => thread.cellId === 'cell1')).toBe(true);
    });
  });
  
  describe('comment management', () => {
    it('should add a comment to an existing thread', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread
      const thread = commentSystem.createThread('cell1', 'Initial comment', user1);
      
      // Add a comment to the thread
      const comment = commentSystem.addComment(
        thread.id,
        'Second comment',
        user2,
        CommentPriority.High
      );
      
      expect(comment).toBeDefined();
      expect(comment?.content).toBe('Second comment');
      expect(comment?.author).toEqual(user2);
      expect(comment?.priority).toBe(CommentPriority.High);
      
      // Verify the comment is in the thread
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments).toHaveLength(2);
      expect(updatedThread?.comments[1].id).toBe(comment?.id);
    });
    
    it('should update an existing comment', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Initial comment', user);
      const commentId = thread.comments[0].id;
      
      // Update the comment
      const updatedComment = commentSystem.updateComment(
        thread.id,
        commentId,
        'Updated comment',
        CommentPriority.High
      );
      
      expect(updatedComment).toBeDefined();
      expect(updatedComment?.content).toBe('Updated comment');
      expect(updatedComment?.priority).toBe(CommentPriority.High);
      expect(updatedComment?.edited).toBe(true);
      
      // Verify the comment is updated in the thread
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].content).toBe('Updated comment');
    });
    
    it('should delete a comment', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment 1', user);
      
      // Add another comment
      const comment = commentSystem.addComment(thread.id, 'Comment 2', user);
      expect(commentSystem.getThread(thread.id)?.comments).toHaveLength(2);
      
      // Delete the second comment
      commentSystem.deleteComment(thread.id, comment!.id);
      
      // Verify the comment is deleted
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments).toHaveLength(1);
      expect(updatedThread?.comments[0].content).toBe('Comment 1');
    });
    
    it('should delete the thread when the last comment is deleted', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment 1', user);
      const commentId = thread.comments[0].id;
      
      // Delete the only comment
      commentSystem.deleteComment(thread.id, commentId);
      
      // Verify the thread is deleted
      expect(commentSystem.getThread(thread.id)).toBeUndefined();
    });
  });
  
  describe('comment status management', () => {
    it('should resolve a comment', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user1);
      const commentId = thread.comments[0].id;
      
      // Resolve the comment
      const resolvedComment = commentSystem.resolveComment(thread.id, commentId, user2);
      
      expect(resolvedComment).toBeDefined();
      expect(resolvedComment?.status).toBe(CommentStatus.Resolved);
      expect(resolvedComment?.resolvedBy).toEqual(user2);
      expect(resolvedComment?.resolvedAt).toBeDefined();
      
      // Verify the comment is resolved in the thread
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].status).toBe(CommentStatus.Resolved);
    });
    
    it('should reopen a resolved comment', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user1);
      const commentId = thread.comments[0].id;
      
      // Resolve the comment
      commentSystem.resolveComment(thread.id, commentId, user2);
      
      // Reopen the comment
      const reopenedComment = commentSystem.reopenComment(thread.id, commentId);
      
      expect(reopenedComment).toBeDefined();
      expect(reopenedComment?.status).toBe(CommentStatus.Open);
      expect(reopenedComment?.resolvedBy).toBeUndefined();
      expect(reopenedComment?.resolvedAt).toBeUndefined();
      
      // Verify the comment is reopened in the thread
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].status).toBe(CommentStatus.Open);
    });
    
    it('should archive a comment', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user);
      const commentId = thread.comments[0].id;
      
      // Archive the comment
      const archivedComment = commentSystem.archiveComment(thread.id, commentId);
      
      expect(archivedComment).toBeDefined();
      expect(archivedComment?.status).toBe(CommentStatus.Archived);
      
      // Verify the comment is archived in the thread
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].status).toBe(CommentStatus.Archived);
    });
  });
  
  describe('reply management', () => {
    it('should add a reply to a comment', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user1);
      const commentId = thread.comments[0].id;
      
      // Add a reply to the comment
      const reply = commentSystem.addReply(thread.id, commentId, 'Reply', user2);
      
      expect(reply).toBeDefined();
      expect(reply?.content).toBe('Reply');
      expect(reply?.author).toEqual(user2);
      
      // Verify the reply is in the comment
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].replies).toHaveLength(1);
      expect(updatedThread?.comments[0].replies[0].id).toBe(reply?.id);
    });
    
    it('should update a reply', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user1);
      const commentId = thread.comments[0].id;
      
      // Add a reply
      const reply = commentSystem.addReply(thread.id, commentId, 'Reply', user2);
      
      // Update the reply
      const updatedReply = commentSystem.updateReply(
        thread.id,
        commentId,
        reply!.id,
        'Updated reply'
      );
      
      expect(updatedReply).toBeDefined();
      expect(updatedReply?.content).toBe('Updated reply');
      expect(updatedReply?.edited).toBe(true);
      
      // Verify the reply is updated in the comment
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].replies[0].content).toBe('Updated reply');
    });
    
    it('should delete a reply', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user1);
      const commentId = thread.comments[0].id;
      
      // Add a reply
      const reply = commentSystem.addReply(thread.id, commentId, 'Reply', user2);
      
      // Delete the reply
      commentSystem.deleteReply(thread.id, commentId, reply!.id);
      
      // Verify the reply is deleted
      const updatedThread = commentSystem.getThread(thread.id);
      expect(updatedThread?.comments[0].replies).toHaveLength(0);
    });
  });
  
  describe('notification management', () => {
    it('should create notifications for new comments', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread with a comment
      commentSystem.createThread('cell1', 'Comment', user);
      
      // Verify a notification was created
      const notifications = commentSystem.getNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe('new-comment');
      expect(notifications[0].userId).toBe(user.id);
    });
    
    it('should create notifications for replies', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment
      const thread = commentSystem.createThread('cell1', 'Comment', user1);
      const commentId = thread.comments[0].id;
      
      // Add a reply
      commentSystem.addReply(thread.id, commentId, 'Reply', user2);
      
      // Verify notifications were created
      const notifications = commentSystem.getNotifications();
      expect(notifications).toHaveLength(2); // One for the comment, one for the reply
      expect(notifications[1].type).toBe('new-reply');
      expect(notifications[1].userId).toBe(user2.id);
    });
    
    it('should create notifications for mentions', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create a thread with a comment that mentions user2
      commentSystem.createThread('cell1', 'Comment mentioning @user2', user1);
      
      // Verify notifications were created
      const notifications = commentSystem.getNotifications();
      expect(notifications.length).toBeGreaterThan(1); // At least one for the comment and one for the mention
      expect(notifications.some(n => n.type === 'mention')).toBe(true);
    });
    
    it('should mark notifications as read', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread with a comment
      commentSystem.createThread('cell1', 'Comment', user);
      
      // Get the notification
      const notifications = commentSystem.getNotifications();
      const notificationId = notifications[0].id;
      
      // Mark the notification as read
      commentSystem.markNotificationAsRead(notificationId);
      
      // Verify the notification is marked as read
      const updatedNotifications = commentSystem.getNotifications();
      expect(updatedNotifications[0].read).toBe(true);
      
      // Verify unread notifications filter
      expect(commentSystem.getUnreadNotifications()).toHaveLength(0);
    });
    
    it('should mark all notifications as read', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create multiple threads with comments
      commentSystem.createThread('cell1', 'Comment 1', user);
      commentSystem.createThread('cell2', 'Comment 2', user);
      
      // Verify we have unread notifications
      expect(commentSystem.getUnreadNotifications()).toHaveLength(2);
      
      // Mark all notifications as read
      commentSystem.markAllNotificationsAsRead();
      
      // Verify all notifications are read
      expect(commentSystem.getUnreadNotifications()).toHaveLength(0);
    });
  });
  
  describe('filtering and searching', () => {
    it('should filter comments by status', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create threads with comments in different states
      const thread1 = commentSystem.createThread('cell1', 'Open comment', user);
      const thread2 = commentSystem.createThread('cell2', 'Resolved comment', user);
      
      // Resolve the second comment
      commentSystem.resolveComment(thread2.id, thread2.comments[0].id, user);
      
      // Filter by open status
      const openThreads = commentSystem.filterComments({ status: CommentStatus.Open });
      expect(openThreads).toHaveLength(1);
      expect(openThreads[0].id).toBe(thread1.id);
      
      // Filter by resolved status
      const resolvedThreads = commentSystem.filterComments({ status: CommentStatus.Resolved });
      expect(resolvedThreads).toHaveLength(1);
      expect(resolvedThreads[0].id).toBe(thread2.id);
    });
    
    it('should filter comments by cell ID', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create threads for different cells
      commentSystem.createThread('cell1', 'Comment 1', user);
      commentSystem.createThread('cell2', 'Comment 2', user);
      commentSystem.createThread('cell1', 'Comment 3', user);
      
      // Filter by cell ID
      const cell1Threads = commentSystem.filterComments({ cellId: 'cell1' });
      expect(cell1Threads).toHaveLength(2);
      expect(cell1Threads.every(thread => thread.cellId === 'cell1')).toBe(true);
    });
    
    it('should filter comments by author', () => {
      const { commentSystem } = createCommentSystem();
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // Create threads with different authors
      commentSystem.createThread('cell1', 'Comment by user1', user1);
      commentSystem.createThread('cell2', 'Comment by user2', user2);
      
      // Filter by author
      const user1Threads = commentSystem.filterComments({ authorId: 'user1' });
      expect(user1Threads).toHaveLength(1);
      expect(user1Threads[0].comments[0].author.id).toBe('user1');
    });
    
    it('should search comments by text content', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create threads with different content
      commentSystem.createThread('cell1', 'This is about Python', user);
      commentSystem.createThread('cell2', 'This is about JavaScript', user);
      
      // Search for Python
      const pythonThreads = commentSystem.searchComments('Python');
      expect(pythonThreads).toHaveLength(1);
      expect(pythonThreads[0].comments[0].content).toContain('Python');
      
      // Search for JavaScript
      const jsThreads = commentSystem.searchComments('JavaScript');
      expect(jsThreads).toHaveLength(1);
      expect(jsThreads[0].comments[0].content).toContain('JavaScript');
    });
  });
  
  describe('statistics', () => {
    it('should provide accurate statistics', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create threads with comments in different states
      const thread1 = commentSystem.createThread('cell1', 'Open comment', user);
      const thread2 = commentSystem.createThread('cell2', 'To be resolved', user);
      const thread3 = commentSystem.createThread('cell3', 'To be archived', user);
      
      // Add replies
      commentSystem.addReply(thread1.id, thread1.comments[0].id, 'Reply 1', user);
      commentSystem.addReply(thread1.id, thread1.comments[0].id, 'Reply 2', user);
      
      // Change statuses
      commentSystem.resolveComment(thread2.id, thread2.comments[0].id, user);
      commentSystem.archiveComment(thread3.id, thread3.comments[0].id);
      
      // Get statistics
      const stats = commentSystem.getStatistics();
      
      expect(stats.totalThreads).toBe(3);
      expect(stats.totalComments).toBe(3);
      expect(stats.totalReplies).toBe(2);
      expect(stats.openComments).toBe(1);
      expect(stats.resolvedComments).toBe(1);
      expect(stats.archivedComments).toBe(1);
    });
  });
  
  describe('multi-user collaboration', () => {
    it('should synchronize comments between users', () => {
      // Create two comment systems with connected Yjs docs
      const { ydoc: ydoc1, commentSystem: commentSystem1 } = createCommentSystem();
      const { ydoc: ydoc2, commentSystem: commentSystem2 } = createCommentSystem();
      
      // Connect the Yjs documents
      connectYjsDocs(ydoc1, ydoc2);
      
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // User 1 creates a thread
      const thread = commentSystem1.createThread('cell1', 'Comment from User 1', user1);
      
      // Verify User 2 can see the thread
      const threadsForUser2 = commentSystem2.getThreads();
      expect(threadsForUser2).toHaveLength(1);
      expect(threadsForUser2[0].id).toBe(thread.id);
      expect(threadsForUser2[0].comments[0].content).toBe('Comment from User 1');
      
      // User 2 adds a comment to the thread
      commentSystem2.addComment(thread.id, 'Reply from User 2', user2);
      
      // Verify User 1 can see the new comment
      const updatedThreadForUser1 = commentSystem1.getThread(thread.id);
      expect(updatedThreadForUser1?.comments).toHaveLength(2);
      expect(updatedThreadForUser1?.comments[1].content).toBe('Reply from User 2');
    });
    
    it('should synchronize comment status changes', () => {
      // Create two comment systems with connected Yjs docs
      const { ydoc: ydoc1, commentSystem: commentSystem1 } = createCommentSystem();
      const { ydoc: ydoc2, commentSystem: commentSystem2 } = createCommentSystem();
      
      // Connect the Yjs documents
      connectYjsDocs(ydoc1, ydoc2);
      
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // User 1 creates a thread
      const thread = commentSystem1.createThread('cell1', 'Comment from User 1', user1);
      const commentId = thread.comments[0].id;
      
      // User 2 resolves the comment
      commentSystem2.resolveComment(thread.id, commentId, user2);
      
      // Verify User 1 sees the comment as resolved
      const updatedThreadForUser1 = commentSystem1.getThread(thread.id);
      expect(updatedThreadForUser1?.comments[0].status).toBe(CommentStatus.Resolved);
      expect(updatedThreadForUser1?.comments[0].resolvedBy?.id).toBe(user2.id);
    });
    
    it('should synchronize notifications', () => {
      // Create two comment systems with connected Yjs docs
      const { ydoc: ydoc1, commentSystem: commentSystem1 } = createCommentSystem();
      const { ydoc: ydoc2, commentSystem: commentSystem2 } = createCommentSystem();
      
      // Connect the Yjs documents
      connectYjsDocs(ydoc1, ydoc2);
      
      const user1 = createMockUser('user1', 'User 1');
      const user2 = createMockUser('user2', 'User 2');
      
      // User 1 creates a thread
      commentSystem1.createThread('cell1', 'Comment from User 1', user1);
      
      // Verify both users see the notification
      expect(commentSystem1.getNotifications()).toHaveLength(1);
      expect(commentSystem2.getNotifications()).toHaveLength(1);
      
      // User 2 marks the notification as read
      const notificationId = commentSystem2.getNotifications()[0].id;
      commentSystem2.markNotificationAsRead(notificationId);
      
      // Verify the notification is marked as read for both users
      expect(commentSystem1.getNotifications()[0].read).toBe(true);
      expect(commentSystem2.getNotifications()[0].read).toBe(true);
    });
  });
  
  describe('event handling', () => {
    it('should emit events when comments are added', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Set up event listener
      const changeHandler = jest.fn();
      commentSystem.changed.connect(changeHandler);
      
      // Create a thread
      const thread = commentSystem.createThread('cell1', 'Comment', user);
      
      // Verify the event was emitted
      expect(changeHandler).toHaveBeenCalled();
      expect(changeHandler.mock.calls[0][1].type).toBe(CommentChangeType.ThreadAdded);
      expect(changeHandler.mock.calls[0][1].threadId).toBe(thread.id);
    });
    
    it('should emit events when comments are updated', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread
      const thread = commentSystem.createThread('cell1', 'Comment', user);
      const commentId = thread.comments[0].id;
      
      // Set up event listener
      const changeHandler = jest.fn();
      commentSystem.changed.connect(changeHandler);
      
      // Update the comment
      commentSystem.updateComment(thread.id, commentId, 'Updated comment');
      
      // Verify the event was emitted
      expect(changeHandler).toHaveBeenCalled();
      expect(changeHandler.mock.calls[0][1].type).toBe(CommentChangeType.CommentUpdated);
      expect(changeHandler.mock.calls[0][1].commentId).toBe(commentId);
    });
    
    it('should emit events when notifications change', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread to generate a notification
      commentSystem.createThread('cell1', 'Comment', user);
      
      // Set up event listener
      const notificationsHandler = jest.fn();
      commentSystem.notificationsChanged.connect(notificationsHandler);
      
      // Mark all notifications as read
      commentSystem.markAllNotificationsAsRead();
      
      // Verify the event was emitted
      expect(notificationsHandler).toHaveBeenCalled();
      expect(notificationsHandler.mock.calls[0][1]).toBeInstanceOf(Array);
    });
  });
  
  describe('error handling', () => {
    it('should handle non-existent thread IDs gracefully', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Try to add a comment to a non-existent thread
      const comment = commentSystem.addComment('non-existent-id', 'Comment', user);
      
      // Should return undefined
      expect(comment).toBeUndefined();
    });
    
    it('should handle non-existent comment IDs gracefully', () => {
      const { commentSystem } = createCommentSystem();
      const user = createMockUser('user1', 'User 1');
      
      // Create a thread
      const thread = commentSystem.createThread('cell1', 'Comment', user);
      
      // Try to update a non-existent comment
      const updatedComment = commentSystem.updateComment(thread.id, 'non-existent-id', 'Updated');
      
      // Should return undefined
      expect(updatedComment).toBeUndefined();
    });
  });
  
  describe('cleanup', () => {
    it('should dispose resources properly', () => {
      const { commentSystem } = createCommentSystem();
      
      // Create some data
      const user = createMockUser('user1', 'User 1');
      commentSystem.createThread('cell1', 'Comment', user);
      
      // Set up event listeners
      const changeHandler = jest.fn();
      const notificationsHandler = jest.fn();
      commentSystem.changed.connect(changeHandler);
      commentSystem.notificationsChanged.connect(notificationsHandler);
      
      // Dispose the comment system
      commentSystem.dispose();
      
      // Verify the signals are disconnected
      expect(commentSystem.changed.hasConnections).toBe(false);
      expect(commentSystem.notificationsChanged.hasConnections).toBe(false);
    });
  });
});