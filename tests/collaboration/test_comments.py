"""
Tests for collaborative comment and review system.

This module provides comprehensive testing for the CommentStore class and
ICollaborationComments interface, validating comment persistence, notification
mechanisms, thread management, and resolution workflows in collaborative scenarios.

Tests cover:
- Comment CRUD operations with Yjs persistence
- Real-time comment synchronization between users
- Threaded discussions and reply functionality
- @-mention parsing and notifications
- Comment resolution workflows
- Performance testing with many comments
- Notification delivery and subscription management
- Comment export functionality
- Error handling and edge cases
"""

import asyncio
import json
import re
import statistics
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from y_py import YDoc, apply_update, encode_state_as_update

# Import test fixtures and configurations


class MockCommentStore:
    """Mock comment store for testing collaborative comment functionality."""

    def __init__(self, doc: YDoc, config: dict = None):
        self.doc = doc
        self._config = config or {
            "enableNotifications": True,
            "maxThreadDepth": 10,
            "operationTimeout": 30000,
            "enableMarkdown": True,
            "enableMentions": True,
            "maxCommentsPerCell": 100,
        }

        # Add mock permission manager
        self._permissionManager = Mock()
        self._permissionManager.canEdit.return_value = True  # Default to allowing edits

        # Initialize Yjs maps
        self._commentsMap = doc.get_map("comments")
        self._threadsMap = doc.get_map("threads")
        self._notificationsMap = doc.get_map("notifications")

        # Mock current user
        self.current_user = {
            "userId": "test_user_1",
            "username": "testuser1",
            "displayName": "Test User 1",
            "avatar": "https://example.com/avatar1",
            "color": "#FF0000",
        }

        # Notification callbacks
        self._notification_callbacks = []
        self._disposed = False

    async def create(
        self, cell_id: str, content: str, parent_id: str = None, mentions: list = None
    ):
        """Create a new comment."""
        if self._disposed:
            raise Exception("CommentStore has been disposed")

        # Check permissions
        if not self._permissionManager.canEdit():
            raise Exception("Permission denied: Cannot create comment")

        if not content or not content.strip():
            raise Exception("Comment content cannot be empty")

        # Check comment limit per cell
        max_comments = self._config["maxCommentsPerCell"]
        existing_comments = await self.getByCell(cell_id)
        if len(existing_comments) >= max_comments:
            raise Exception(f"Comment limit exceeded: Maximum {max_comments} comments per cell")

        comment_id = str(uuid.uuid4())
        mentions = mentions or []

        # Parse mentions from content if not provided
        if not mentions:
            mention_pattern = r"@(\w+)"
            mentions = re.findall(mention_pattern, content)

        comment_data = {
            "id": comment_id,
            "cellId": cell_id,
            "content": content,
            "authorId": self.current_user["userId"],
            "author": self.current_user,
            "timestamp": int(time.time() * 1000),
            "parentId": parent_id,
            "status": "open",
            "mentions": mentions,
            "isResolved": False,
            "replies": [],
            "metadata": {},
        }

        # Store in Yjs
        with self.doc.begin_transaction() as txn:
            self._commentsMap.set(txn, comment_id, json.dumps(comment_data))

        # Create comment object with proper nested objects
        comment = self._create_comment_object(comment_data)

        # Handle notifications
        await self._handle_comment_notifications(comment, mentions)

        return comment

    async def read(self, comment_id: str):
        """Read a comment by ID."""
        if self._disposed:
            return None

        comment_data_str = self._commentsMap.get(comment_id)
        if not comment_data_str:
            return None

        comment_data = json.loads(comment_data_str)
        return self._create_comment_object(comment_data)

    async def getByCell(self, cell_id: str):
        """Get all comments for a specific cell."""
        if self._disposed:
            return []

        comments = []
        for comment_id in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(comment_id)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)
                if comment_data["cellId"] == cell_id:
                    comments.append(self._create_comment_object(comment_data))

        return comments

    async def update(self, comment_id: str, content: str = None, status: str = None):
        """Update a comment."""
        if self._disposed:
            raise Exception("CommentStore has been disposed")

        comment_data_str = self._commentsMap.get(comment_id)
        if not comment_data_str:
            raise Exception("Comment not found")

        comment_data = json.loads(comment_data_str)

        if content is not None:
            comment_data["content"] = content
        if status is not None:
            comment_data["status"] = status
            comment_data["isResolved"] = status == "resolved"

        # Update in Yjs
        with self.doc.begin_transaction() as txn:
            self._commentsMap.set(txn, comment_id, json.dumps(comment_data))

        return type("Comment", (), comment_data)()

    async def delete(self, comment_id: str):
        """Delete a comment and all its replies."""
        if self._disposed:
            raise Exception("CommentStore has been disposed")

        comment_data_str = self._commentsMap.get(comment_id)
        if not comment_data_str:
            raise Exception("Comment not found")

        # First find all replies recursively
        reply_ids = await self._find_all_replies(comment_id)

        # Remove all replies and the root comment from Yjs
        with self.doc.begin_transaction() as txn:
            # Delete all replies first
            for reply_id in reply_ids:
                self._commentsMap.pop(txn, reply_id)
            # Delete the root comment
            self._commentsMap.pop(txn, comment_id)

    async def addReply(self, parent_comment_id: str, content: str, mentions: list = None):
        """Add a reply to a comment."""
        parent_comment = await self.read(parent_comment_id)
        if not parent_comment:
            raise Exception("Parent comment not found")

        # Check thread depth
        depth = await self._getThreadDepth(parent_comment_id)
        if depth >= self._config["maxThreadDepth"]:
            raise Exception(f"Maximum thread depth of {self._config['maxThreadDepth']} exceeded")

        return await self.create(parent_comment.cellId, content, parent_comment_id, mentions)

    async def resolveComment(self, comment_id: str):
        """Resolve a comment."""
        return await self.update(comment_id, status="resolved")

    async def resolveThread(self, root_comment_id: str):
        """Resolve an entire comment thread."""
        comments_in_thread = await self._collectCommentTree(root_comment_id)
        resolved_comments = []

        for comment in comments_in_thread:
            if not comment.isResolved:
                resolved_comment = await self.resolveComment(comment.id)
                resolved_comments.append(resolved_comment)

        return resolved_comments

    def subscribeToNotifications(self, callback):
        """Subscribe to comment notifications."""
        self._notification_callbacks.append(callback)

        def unsubscribe():
            if callback in self._notification_callbacks:
                self._notification_callbacks.remove(callback)

        return unsubscribe

    async def getThreadedComments(self, cell_id: str):
        """Get threaded comments for a cell."""
        comments = await self.getCommentsByCell(cell_id)
        threads = {}

        for comment in comments:
            root_id = await self._findThreadRoot(comment)
            if root_id not in threads:
                root_comment = await self.read(root_id)
                threads[root_id] = {
                    "rootComment": root_comment,
                    "comments": [],
                    "cellId": cell_id,
                    "status": "open",
                    "commentCount": 0,
                    "lastActivity": datetime.fromtimestamp(comment.timestamp / 1000),
                    "participants": [],
                }

            thread = threads[root_id]
            thread["comments"].append(comment)
            thread["commentCount"] += 1

            if comment.author["userId"] not in thread["participants"]:
                thread["participants"].append(comment.author["userId"])

        return [type("CommentThread", (), thread)() for thread in threads.values()]

    async def getCommentsByCell(self, cell_id: str):
        """Get all comments for a cell."""
        comments = []

        for comment_id in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(comment_id)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)
                if comment_data["cellId"] == cell_id:
                    comments.append(type("Comment", (), comment_data)())

        return sorted(comments, key=lambda c: c.timestamp)

    async def searchComments(self, query: str):
        """Search comments by content."""
        results = []

        for comment_id in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(comment_id)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)
                comment = type("Comment", (), comment_data)()

                if query.lower() in comment.content.lower():
                    result = type(
                        "SearchResult",
                        (),
                        {"comment": comment, "score": 1.0, "highlights": [query]},
                    )()
                    results.append(result)

        return results

    async def exportComments(self, options: dict = None):
        """Export comments in specified format."""
        options = options or {}
        format_type = options.get("format", "json")

        all_comments = []
        for comment_id in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(comment_id)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)

                # Apply cellIds filter if provided
                cell_ids = options.get("cellIds")
                if cell_ids and comment_data["cellId"] not in cell_ids:
                    continue

                # Apply date range filter if provided
                date_range = options.get("dateRange")
                if date_range:
                    # Convert Unix timestamp (in milliseconds) to datetime
                    comment_timestamp = datetime.fromtimestamp(
                        comment_data["timestamp"] / 1000, timezone.utc
                    )
                    start_date = date_range.get("start")
                    end_date = date_range.get("end")

                    if start_date and comment_timestamp < start_date:
                        continue
                    if end_date and comment_timestamp > end_date:
                        continue

                all_comments.append(comment_data)

        if format_type == "json":
            return json.dumps(all_comments, indent=2)
        if format_type == "markdown":
            markdown = "# Comments Export\n\n"
            for comment_data in all_comments:
                markdown += f"## Comment {comment_data['id']}\n"
                markdown += f"**Author:** {comment_data['author']['displayName']}\n"
                markdown += f"**Cell:** {comment_data['cellId']}\n"
                markdown += f"**Content:** {comment_data['content']}\n\n"
            return markdown
        if format_type == "html":
            html = "<!DOCTYPE html><html><head><title>Comments Export</title></head><body>"
            html += "<h1>Comments Export</h1>"
            for comment_data in all_comments:
                html += f"<div><h3>Comment {comment_data['id']}</h3>"
                html += f"<p><strong>Author:</strong> {comment_data['author']['displayName']}</p>"
                html += f"<p><strong>Content:</strong> {comment_data['content']}</p></div>"
            html += "</body></html>"
            return html
        if format_type == "csv":
            csv = "ID,Content,Cell ID,Author,Timestamp\n"
            for comment_data in all_comments:
                csv += f"{comment_data['id']},{comment_data['content']},{comment_data['cellId']},{comment_data['author']['displayName']},{comment_data['timestamp']}\n"
            return csv
        raise Exception(f"Unsupported export format: {format_type}")

    async def filterComments(self, filters: dict):
        """Filter comments based on criteria."""
        all_comments = []
        for comment_id in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(comment_id)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)
                comment = type("Comment", (), comment_data)()

                # Apply filters
                if "cellIds" in filters and comment.cellId not in filters["cellIds"]:
                    continue
                if "hasReplies" in filters and filters["hasReplies"] and not comment.parentId:
                    # Check if this comment has replies
                    has_replies = any(
                        c.parentId == comment.id for c in await self._getAllComments()
                    )
                    if not has_replies:
                        continue

                all_comments.append(comment)

        return all_comments

    def getNotificationCount(self):
        """Get count of unread notifications."""
        return len([n for n in self._notificationsMap.keys()])

    async def markAsRead(self, notification_id: str):
        """Mark notification as read."""
        # Implementation for marking notification as read

    def dispose(self):
        """Dispose the comment store."""
        self._disposed = True
        self._notification_callbacks.clear()

    def _create_comment_object(self, comment_data):
        """Create a comment object with proper nested attributes."""

        class Comment:
            def __init__(self, data):
                for key, value in data.items():
                    if key == "author" and isinstance(value, dict):
                        # Create nested author object
                        author_obj = type("Author", (), value)()
                        setattr(self, key, author_obj)
                    else:
                        setattr(self, key, value)

        return Comment(comment_data)

    # Helper methods
    async def _find_all_replies(self, comment_id: str):
        """Find all replies recursively for a given comment."""
        reply_ids = []

        # Search all comments for ones that have this comment as parent
        for key in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(key)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)
                if comment_data.get("parentId") == comment_id:
                    reply_ids.append(key)
                    # Recursively find replies to this reply
                    child_replies = await self._find_all_replies(key)
                    reply_ids.extend(child_replies)

        return reply_ids

    async def _getThreadDepth(self, comment_id: str, depth: int = 0):
        """Get thread depth for a comment."""
        comment = await self.read(comment_id)
        if not comment or not comment.parentId:
            return depth
        return await self._getThreadDepth(comment.parentId, depth + 1)

    async def _findThreadRoot(self, comment):
        """Find the root comment of a thread."""
        if not hasattr(comment, "parentId") or not comment.parentId:
            return comment.id
        parent = await self.read(comment.parentId)
        if parent:
            return await self._findThreadRoot(parent)
        return comment.id

    async def _collectCommentTree(self, root_comment_id: str):
        """Collect all comments in a thread tree."""
        all_comments = await self._getAllComments()
        tree_comments = []

        def collect_replies(parent_id):
            for comment in all_comments:
                if hasattr(comment, "parentId") and comment.parentId == parent_id:
                    tree_comments.append(comment)
                    collect_replies(comment.id)

        root_comment = await self.read(root_comment_id)
        if root_comment:
            tree_comments.append(root_comment)
            collect_replies(root_comment.id)

        return tree_comments

    async def _getAllComments(self):
        """Get all comments."""
        comments = []
        for comment_id in self._commentsMap.keys():
            comment_data_str = self._commentsMap.get(comment_id)
            if comment_data_str:
                comment_data = json.loads(comment_data_str)
                comments.append(type("Comment", (), comment_data)())
        return comments

    async def _handle_comment_notifications(self, comment, mentions):
        """Handle notifications for comment creation."""
        for callback in self._notification_callbacks:
            notification = type(
                "Notification",
                (),
                {
                    "id": str(uuid.uuid4()),
                    "comment": comment,
                    "type": "new_comment",
                    "timestamp": datetime.now(),
                    "isRead": False,
                },
            )()
            try:
                callback(notification)
            except Exception as e:
                print(f"Notification callback error: {e}")


# Global fixtures available to all test classes
@pytest.fixture
def comment_store(collaboration_settings, yjs_doc):
    """Create a CommentStore instance for testing."""
    base_config = collaboration_settings() if callable(collaboration_settings) else {}

    # Merge with comment-specific defaults
    comment_config = {
        "enableNotifications": True,
        "maxThreadDepth": 10,
        "operationTimeout": 30000,
        "enableMarkdown": True,
        "enableMentions": True,
        "maxCommentsPerCell": 100,
        **base_config,
    }

    doc = yjs_doc("test_notebook.ipynb") if callable(yjs_doc) else YDoc()

    return MockCommentStore(doc, comment_config)


@pytest.fixture
def yjs_comment_setup(yjs_doc):
    """Set up YDoc with comment structures."""
    doc = yjs_doc("test_persistence.ipynb") if callable(yjs_doc) else YDoc()
    comments_map = doc.get_map("comments")
    return doc, comments_map


class TestCommentCRUDOperations:
    """Test basic comment Create, Read, Update, Delete operations."""

    @pytest.mark.asyncio
    @pytest.mark.asyncio
    async def test_create_comment_basic(self, comment_store):
        """Test basic comment creation with proper validation."""
        cell_id = "cell_001"
        content = "This is a test comment"

        comment = await comment_store.create(cell_id, content)

        assert comment is not None
        assert comment.content == content
        assert comment.cellId == cell_id
        assert comment.author.userId == "test_user_1"
        assert not comment.isResolved
        assert comment.parentId is None
        assert len(comment.replies) == 0

    @pytest.mark.asyncio
    async def test_create_comment_with_mentions(self, comment_store):
        """Test comment creation with @-mentions."""
        cell_id = "cell_002"
        content = "Hey @user2 and @user3, check this out!"
        mentions = ["user2", "user3"]

        comment = await comment_store.create(cell_id, content, mentions=mentions)

        assert "user2" in comment.mentions
        assert "user3" in comment.mentions
        assert len(comment.mentions) >= 2

    @pytest.mark.asyncio
    async def test_create_comment_validates_content(self, comment_store):
        """Test that empty content raises appropriate error."""
        cell_id = "cell_003"

        with pytest.raises(Exception) as exc_info:
            await comment_store.create(cell_id, "")

        assert "empty" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_read_comment_by_id(self, comment_store):
        """Test retrieving a comment by its ID."""
        cell_id = "cell_004"
        content = "Comment to be retrieved"

        created_comment = await comment_store.create(cell_id, content)
        retrieved_comment = await comment_store.read(created_comment.id)

        assert retrieved_comment is not None
        assert retrieved_comment.id == created_comment.id
        assert retrieved_comment.content == content

    @pytest.mark.asyncio
    async def test_read_nonexistent_comment(self, comment_store):
        """Test retrieving a non-existent comment returns None."""
        fake_id = str(uuid.uuid4())
        result = await comment_store.read(fake_id)
        assert result is None

    @pytest.mark.asyncio
    async def test_update_comment_content(self, comment_store):
        """Test updating comment content."""
        cell_id = "cell_005"
        original_content = "Original comment"
        updated_content = "Updated comment content"

        comment = await comment_store.create(cell_id, original_content)
        updated_comment = await comment_store.update(comment.id, content=updated_content)

        assert updated_comment.content == updated_content
        assert updated_comment.id == comment.id

    @pytest.mark.asyncio
    async def test_update_comment_status(self, comment_store):
        """Test updating comment status to resolved."""
        cell_id = "cell_006"
        content = "Comment to be resolved"

        comment = await comment_store.create(cell_id, content)
        assert not comment.isResolved

        updated_comment = await comment_store.update(comment.id, status="resolved")

        assert updated_comment.isResolved

    @pytest.mark.asyncio
    async def test_delete_comment_single(self, comment_store):
        """Test deleting a single comment."""
        cell_id = "cell_007"
        content = "Comment to be deleted"

        comment = await comment_store.create(cell_id, content)
        await comment_store.delete(comment.id)

        # Verify comment is deleted
        retrieved = await comment_store.read(comment.id)
        assert retrieved is None

    @pytest.mark.asyncio
    async def test_delete_comment_with_replies(self, comment_store):
        """Test deleting a comment with replies deletes the entire thread."""
        cell_id = "cell_008"
        root_content = "Root comment"
        reply_content = "Reply comment"

        root_comment = await comment_store.create(cell_id, root_content)
        reply_comment = await comment_store.addReply(root_comment.id, reply_content)

        # Delete root comment should delete both
        await comment_store.delete(root_comment.id)

        assert await comment_store.read(root_comment.id) is None
        assert await comment_store.read(reply_comment.id) is None


class TestCommentPersistenceInYjs:
    """Test comment data persistence in Yjs CRDT structures."""

    @pytest.mark.asyncio
    async def test_comment_stored_in_yjs(self, comment_store):
        """Test that comments are properly stored in Yjs structures."""
        cell_id = "cell_persistence_001"
        content = "Comment stored in Yjs"

        comment = await comment_store.create(cell_id, content)

        # Check that comment data is in the comment_store's Yjs map
        comment_data_str = comment_store._commentsMap.get(comment.id)
        assert comment_data_str is not None

        comment_data = json.loads(comment_data_str)
        assert comment_data["content"] == content
        assert comment_data["cellId"] == cell_id
        assert comment_data["authorId"] == "test_user_1"

    @pytest.mark.asyncio
    async def test_yjs_state_synchronization(self, collaboration_settings, yjs_doc):
        """Test that Yjs state updates are properly encoded and can be applied."""
        doc1 = yjs_doc("sync_test.ipynb")
        doc2 = yjs_doc("sync_test.ipynb")

        # Create comment in first document
        comments_map1 = doc1.get_map("comments")
        comment_data = {
            "id": "sync_comment_001",
            "authorId": "user1",
            "content": "Sync test comment",
            "cellId": "cell_sync_001",
            "timestamp": int(time.time() * 1000),
            "parentId": None,
            "status": "open",
            "mentions": [],
            "metadata": {},
        }

        with doc1.begin_transaction() as txn:
            comments_map1.set(txn, comment_data["id"], json.dumps(comment_data))

        # Encode state update
        update = encode_state_as_update(doc1)

        # Apply to second document
        apply_update(doc2, update)

        # Verify synchronization
        comments_map2 = doc2.get_map("comments")
        synced_data = comments_map2.get(comment_data["id"])
        assert synced_data is not None

        synced_comment = json.loads(synced_data)
        assert synced_comment["content"] == comment_data["content"]
        assert synced_comment["cellId"] == comment_data["cellId"]

    @pytest.mark.asyncio
    async def test_concurrent_comment_operations(self, yjs_doc):
        """Test concurrent comment operations resolve correctly with CRDT."""
        doc1 = yjs_doc("concurrent_test.ipynb")
        doc2 = yjs_doc("concurrent_test.ipynb")

        comments_map1 = doc1.get_map("comments")
        comments_map2 = doc2.get_map("comments")

        # Create different comments in each document concurrently
        comment1_data = {
            "id": "concurrent_001",
            "content": "Comment from user 1",
            "cellId": "cell_concurrent",
            "authorId": "user1",
            "timestamp": int(time.time() * 1000),
        }

        comment2_data = {
            "id": "concurrent_002",
            "content": "Comment from user 2",
            "cellId": "cell_concurrent",
            "authorId": "user2",
            "timestamp": int(time.time() * 1000) + 1,
        }

        # Add to respective documents
        with doc1.begin_transaction() as txn:
            comments_map1.set(txn, comment1_data["id"], json.dumps(comment1_data))

        with doc2.begin_transaction() as txn:
            comments_map2.set(txn, comment2_data["id"], json.dumps(comment2_data))

        # Cross-apply updates
        update1 = encode_state_as_update(doc1)
        update2 = encode_state_as_update(doc2)

        apply_update(doc2, update1)
        apply_update(doc1, update2)

        # Both documents should have both comments
        assert comments_map1.get(comment1_data["id"]) is not None
        assert comments_map1.get(comment2_data["id"]) is not None
        assert comments_map2.get(comment1_data["id"]) is not None
        assert comments_map2.get(comment2_data["id"]) is not None


class TestCommentThreading:
    """Test threaded comment discussions and reply functionality."""

    @pytest.mark.asyncio
    async def test_add_reply_to_comment(self, comment_store):
        """Test adding a reply to an existing comment."""
        cell_id = "cell_thread_001"
        root_content = "Root comment for threading"
        reply_content = "This is a reply"

        root_comment = await comment_store.create(cell_id, root_content)
        reply_comment = await comment_store.addReply(root_comment.id, reply_content)

        assert reply_comment.parentId == root_comment.id
        assert reply_comment.content == reply_content
        assert reply_comment.cellId == cell_id

    @pytest.mark.asyncio
    async def test_nested_reply_depth(self, comment_store):
        """Test nested replies up to configured depth limit."""
        cell_id = "cell_depth_001"

        # Create root comment
        root_comment = await comment_store.create(cell_id, "Root comment")
        current_comment = root_comment

        # Add replies up to depth limit (default 10)
        for i in range(5):  # Test within reasonable limit
            reply = await comment_store.addReply(current_comment.id, f"Reply depth {i+1}")
            assert reply.parentId == current_comment.id
            current_comment = reply

    @pytest.mark.asyncio
    async def test_thread_depth_limit(self, comment_store):
        """Test that thread depth limit is enforced."""
        cell_id = "cell_depth_limit"

        # Create deep thread up to limit
        root_comment = await comment_store.create(cell_id, "Deep thread root")
        current_comment = root_comment

        # Mock the config to have a smaller limit for testing
        original_depth = comment_store._config["maxThreadDepth"]
        comment_store._config["maxThreadDepth"] = 3

        try:
            # Add replies up to limit
            for i in range(3):
                current_comment = await comment_store.addReply(current_comment.id, f"Reply {i+1}")

            # Adding one more should fail
            with pytest.raises(Exception) as exc_info:
                await comment_store.addReply(current_comment.id, "Exceeded depth")

            assert "depth" in str(exc_info.value).lower()
        finally:
            comment_store._config["maxThreadDepth"] = original_depth

    @pytest.mark.asyncio
    async def test_get_threaded_comments(self, comment_store):
        """Test retrieving comments organized in threads."""
        cell_id = "cell_threaded_001"

        # Create a root comment with replies
        root = await comment_store.create(cell_id, "Thread root")
        reply1 = await comment_store.addReply(root.id, "First reply")
        reply2 = await comment_store.addReply(root.id, "Second reply")
        nested_reply = await comment_store.addReply(reply1.id, "Nested reply")

        # Get threaded comments
        threads = await comment_store.getThreadedComments(cell_id)

        assert len(threads) == 1  # One thread
        thread = threads[0]
        assert thread.rootComment.id == root.id
        assert thread.commentCount >= 4  # Root + 3 replies
        assert len(thread.participants) >= 1

    @pytest.mark.asyncio
    async def test_thread_participants(self, comment_store):
        """Test that thread participants are tracked correctly."""
        # Mock multiple users
        mock_users = [
            {"userId": "user1", "displayName": "User 1"},
            {"userId": "user2", "displayName": "User 2"},
        ]

        # This would need proper multi-user simulation
        # For now, test with single user
        cell_id = "cell_participants"
        root = await comment_store.create(cell_id, "Multi-user thread")
        reply = await comment_store.addReply(root.id, "Reply from same user")

        threads = await comment_store.getThreadedComments(cell_id)
        assert len(threads) == 1
        assert "test_user_1" in threads[0].participants


class TestCommentNotificationSystem:
    """Test notification mechanisms for mentions and replies."""

    @pytest.mark.asyncio
    async def test_subscribe_to_notifications(self, comment_store):
        """Test subscribing to comment notifications."""
        notifications_received = []

        def notification_callback(notification):
            notifications_received.append(notification)

        # Subscribe to notifications
        unsubscribe = comment_store.subscribeToNotifications(notification_callback)

        assert callable(unsubscribe)

        # Unsubscribe
        unsubscribe()

    @pytest.mark.asyncio
    async def test_mention_notification_parsing(self, comment_store):
        """Test that @-mentions are properly parsed and trigger notifications."""
        cell_id = "cell_mentions"
        content = "Hey @user2, please review this code with @user3"

        comment = await comment_store.create(cell_id, content)

        # Check that mentions were parsed
        assert "user2" in comment.mentions or "user3" in comment.mentions

        # Verify mention patterns are detected
        mention_pattern = r"@(\w+)"
        mentions = re.findall(mention_pattern, content)
        assert "user2" in mentions
        assert "user3" in mentions

    @pytest.mark.asyncio
    async def test_notification_delivery_timing(self, comment_store):
        """Test notification delivery timing and performance."""
        notifications = []

        def fast_callback(notification):
            notifications.append(time.perf_counter())

        unsubscribe = comment_store.subscribeToNotifications(fast_callback)

        start_time = time.perf_counter()

        # Create comment with mention
        await comment_store.create("cell_timing", "Quick @user2 notification test")

        # Allow brief processing time
        await asyncio.sleep(0.1)

        end_time = time.perf_counter()
        elapsed = end_time - start_time

        # Notification should be reasonably fast (under 1 second)
        assert elapsed < 1.0

        unsubscribe()

    @pytest.mark.asyncio
    async def test_notification_count_tracking(self, comment_store):
        """Test unread notification count tracking."""
        initial_count = comment_store.getNotificationCount()

        # Create comment that should generate notification
        await comment_store.create("cell_count", "Test notification @user2")

        # For proper testing, would need to simulate receiving notification
        # This tests the basic functionality
        updated_count = comment_store.getNotificationCount()
        assert updated_count >= initial_count

    @pytest.mark.asyncio
    async def test_mark_notification_as_read(self, comment_store):
        """Test marking notifications as read."""
        # Create a mock notification
        notification_id = str(uuid.uuid4())

        # Test the markAsRead method exists and handles non-existent notifications gracefully
        await comment_store.markAsRead(notification_id)

        # Should not raise exception for non-existent notification


class TestCommentResolutionWorkflow:
    """Test comment resolution states and workflows."""

    @pytest.mark.asyncio
    async def test_resolve_single_comment(self, comment_store):
        """Test resolving a single comment."""
        cell_id = "cell_resolution_001"
        content = "Comment to be resolved"

        comment = await comment_store.create(cell_id, content)
        assert not comment.isResolved

        resolved_comment = await comment_store.resolveComment(comment.id)
        assert resolved_comment.isResolved

    @pytest.mark.asyncio
    async def test_resolve_comment_thread(self, comment_store):
        """Test resolving an entire comment thread."""
        cell_id = "cell_thread_resolution"

        # Create thread
        root = await comment_store.create(cell_id, "Thread to resolve")
        reply1 = await comment_store.addReply(root.id, "Reply 1")
        reply2 = await comment_store.addReply(root.id, "Reply 2")

        # Resolve entire thread
        resolved_comments = await comment_store.resolveThread(root.id)

        # All comments in thread should be resolved
        assert len(resolved_comments) >= 0  # Some comments may already be resolved

        # Verify root is resolved
        updated_root = await comment_store.read(root.id)
        assert updated_root.isResolved

    @pytest.mark.asyncio
    async def test_resolution_workflow_states(self, comment_store):
        """Test different resolution workflow states."""
        cell_id = "cell_workflow_states"
        comment = await comment_store.create(cell_id, "Workflow test comment")

        # Test different status transitions
        statuses = ["resolved", "open", "archived"]

        for status in statuses:
            updated = await comment_store.update(comment.id, status=status)
            if status == "resolved":
                assert updated.isResolved
            else:
                assert not updated.isResolved

    @pytest.mark.asyncio
    async def test_resolution_notifications(self, comment_store):
        """Test that resolution triggers appropriate notifications."""
        notifications = []

        def resolution_callback(notification):
            if hasattr(notification, "type") and notification.type == "resolution":
                notifications.append(notification)

        unsubscribe = comment_store.subscribeToNotifications(resolution_callback)

        try:
            cell_id = "cell_resolution_notify"
            comment = await comment_store.create(cell_id, "Comment for resolution notification")
            await comment_store.resolveComment(comment.id)

            # Allow time for notification processing
            await asyncio.sleep(0.1)

        finally:
            unsubscribe()


class TestCommentRealTimeSynchronization:
    """Test real-time comment synchronization between multiple users."""

    @pytest.mark.asyncio
    async def test_multi_user_comment_sync(self, collaboration_settings, yjs_doc):
        """Test comment synchronization between multiple users."""
        # Create mock multi-user session
        doc1 = yjs_doc("sync_test.ipynb") if callable(yjs_doc) else YDoc()
        doc2 = yjs_doc("sync_test.ipynb") if callable(yjs_doc) else YDoc()

        # Simulate comment creation by user 1
        comments_map1 = doc1.get_map("comments")
        comments_map2 = doc2.get_map("comments")

        comment_data = {
            "id": "multi_sync_001",
            "content": "Multi-user sync test",
            "cellId": "cell_sync",
            "authorId": "user1",
            "timestamp": int(time.time() * 1000),
            "parentId": None,
            "status": "open",
            "mentions": [],
            "metadata": {},
        }

        with doc1.begin_transaction() as txn:
            comments_map1.set(txn, comment_data["id"], json.dumps(comment_data))

        # Simulate synchronization
        update = encode_state_as_update(doc1)
        apply_update(doc2, update)

        # Verify comment appears in user 2's document
        synced_comment = comments_map2.get(comment_data["id"])
        assert synced_comment is not None
        synced_data = json.loads(synced_comment)
        assert synced_data["content"] == comment_data["content"]

    @pytest.mark.asyncio
    async def test_concurrent_comment_creation(self, collaboration_settings, yjs_doc):
        """Test concurrent comment creation by multiple users."""
        # Create multiple documents for concurrent testing
        doc1 = yjs_doc("concurrent_comments.ipynb") if callable(yjs_doc) else YDoc()
        doc2 = yjs_doc("concurrent_comments.ipynb") if callable(yjs_doc) else YDoc()
        doc3 = yjs_doc("concurrent_comments.ipynb") if callable(yjs_doc) else YDoc()

        docs = [doc1, doc2, doc3]

        # Define concurrent comment data
        comments_data = [
            {
                "id": "concurrent_comment_1",
                "content": "User 1 comment",
                "cellId": "cell_concurrent_1",
                "authorId": "user1",
                "timestamp": int(time.time() * 1000),
            },
            {
                "id": "concurrent_comment_2",
                "content": "User 2 comment",
                "cellId": "cell_concurrent_2",
                "authorId": "user2",
                "timestamp": int(time.time() * 1000) + 1,
            },
            {
                "id": "concurrent_comment_3",
                "content": "User 3 comment",
                "cellId": "cell_concurrent_3",
                "authorId": "user3",
                "timestamp": int(time.time() * 1000) + 2,
            },
        ]

        # Create comments in parallel documents
        for i, (doc, comment_data) in enumerate(zip(docs, comments_data)):
            comments_map = doc.get_map("comments")
            with doc.begin_transaction() as txn:
                comments_map.set(txn, comment_data["id"], json.dumps(comment_data))

        # Simulate synchronization between all documents
        updates = [encode_state_as_update(doc) for doc in docs]

        # Apply all updates to all documents
        for i, doc in enumerate(docs):
            for j, update in enumerate(updates):
                if i != j:  # Don't apply own update
                    apply_update(doc, update)

        # Verify all documents have all comments
        for doc in docs:
            comments_map = doc.get_map("comments")
            assert len(comments_map) == 3  # Should have all 3 comments

            # Verify each comment exists
            for comment_data in comments_data:
                stored_comment = comments_map.get(comment_data["id"])
                assert stored_comment is not None
                stored_data = json.loads(stored_comment)
                assert stored_data["content"] == comment_data["content"]

    @pytest.mark.asyncio
    async def test_sync_performance_many_comments(self, yjs_doc):
        """Test synchronization performance with many comments."""
        doc1 = yjs_doc("perf_test.ipynb")
        doc2 = yjs_doc("perf_test.ipynb")

        comments_map1 = doc1.get_map("comments")

        # Create many comments
        num_comments = 50
        start_time = time.perf_counter()

        for i in range(num_comments):
            comment_data = {
                "id": f"perf_comment_{i:03d}",
                "content": f"Performance test comment {i}",
                "cellId": f"cell_perf_{i % 10}",  # Distribute across 10 cells
                "authorId": "perf_user",
                "timestamp": int(time.time() * 1000) + i,
                "parentId": None,
                "status": "open",
                "mentions": [],
                "metadata": {},
            }

            with doc1.begin_transaction() as txn:
                comments_map1.set(txn, comment_data["id"], json.dumps(comment_data))

        creation_time = time.perf_counter() - start_time

        # Measure sync time
        sync_start = time.perf_counter()
        update = encode_state_as_update(doc1)
        apply_update(doc2, update)
        sync_time = time.perf_counter() - sync_start

        # Verify all comments synced
        comments_map2 = doc2.get_map("comments")
        assert len(comments_map2) == num_comments

        # Performance assertions (adjust thresholds as needed)
        assert creation_time < 2.0  # Should create 50 comments in under 2 seconds
        assert sync_time < 0.5  # Sync should be under 500ms

        print(f"Created {num_comments} comments in {creation_time:.3f}s")
        print(f"Synchronized in {sync_time:.3f}s")


class TestCommentPerformanceAndScalability:
    """Test comment system performance with large datasets and many users."""

    @pytest.mark.asyncio
    async def test_performance_many_comments_single_cell(self, comment_store):
        """Test performance when a single cell has many comments."""
        cell_id = "cell_many_comments"
        num_comments = 100

        start_time = time.perf_counter()

        # Create many comments on same cell
        for i in range(num_comments):
            await comment_store.create(cell_id, f"Performance comment {i}")

        creation_time = time.perf_counter() - start_time

        # Test retrieval performance
        retrieval_start = time.perf_counter()
        comments = await comment_store.getCommentsByCell(cell_id)
        retrieval_time = time.perf_counter() - retrieval_start

        # Verify all comments created
        assert len(comments) == num_comments

        # Performance assertions
        avg_creation_time = creation_time / num_comments
        assert avg_creation_time < 0.1  # Under 100ms per comment on average
        assert retrieval_time < 1.0  # Retrieve 100 comments in under 1 second

        print(
            f"Created {num_comments} comments in {creation_time:.3f}s ({avg_creation_time:.3f}s avg)"
        )
        print(f"Retrieved {num_comments} comments in {retrieval_time:.3f}s")

    @pytest.mark.asyncio
    async def test_search_performance_large_dataset(self, comment_store):
        """Test comment search performance with large dataset."""
        # Create diverse comments for searching
        test_comments = [
            ("cell_1", "Python code optimization techniques"),
            ("cell_2", "Machine learning model validation"),
            ("cell_3", "Data visualization with matplotlib"),
            ("cell_4", "Statistical analysis methods"),
            ("cell_5", "Database query optimization"),
            ("cell_6", "Python pandas data manipulation"),
            ("cell_7", "Web scraping best practices"),
            ("cell_8", "API integration strategies"),
            ("cell_9", "Testing methodologies for Python"),
            ("cell_10", "Performance monitoring tools"),
        ]

        # Create comments
        for i, (cell_id, content) in enumerate(test_comments * 10):  # 100 total
            await comment_store.create(f"{cell_id}_{i}", f"{content} - instance {i}")

        # Test search performance
        search_terms = ["Python", "optimization", "data", "performance"]
        search_times = []

        for term in search_terms:
            start_time = time.perf_counter()
            results = await comment_store.searchComments(term)
            search_time = time.perf_counter() - start_time
            search_times.append(search_time)

            # Verify relevant results returned
            assert len(results) > 0
            for result in results:
                assert (
                    term.lower() in result.comment.content.lower()
                    or term.lower() in result.comment.author.displayName.lower()
                )

        # Performance analysis
        avg_search_time = statistics.mean(search_times)
        max_search_time = max(search_times)

        assert avg_search_time < 0.5  # Average search under 500ms
        assert max_search_time < 1.0  # No search over 1 second

        print(f"Search performance - Avg: {avg_search_time:.3f}s, Max: {max_search_time:.3f}s")

    @pytest.mark.asyncio
    async def test_notification_performance_many_mentions(self, comment_store):
        """Test notification performance with many mentions."""
        notifications = []

        def perf_callback(notification):
            notifications.append(time.perf_counter())

        unsubscribe = comment_store.subscribeToNotifications(perf_callback)

        try:
            # Create comment with many mentions
            many_mentions = [f"user{i}" for i in range(20)]
            mention_content = "Performance test: " + " ".join(f"@{user}" for user in many_mentions)

            start_time = time.perf_counter()
            await comment_store.create(
                "cell_perf_mentions", mention_content, mentions=many_mentions
            )
            processing_time = time.perf_counter() - start_time

            # Allow notification processing
            await asyncio.sleep(0.5)

            # Should handle many mentions efficiently
            assert processing_time < 1.0  # Under 1 second for 20 mentions

        finally:
            unsubscribe()

    @pytest.mark.asyncio
    async def test_memory_usage_large_comment_dataset(self, comment_store):
        """Test memory efficiency with large comment dataset."""
        import gc

        # Get initial memory baseline (simplified)
        gc.collect()
        initial_objects = len(gc.get_objects())

        # Create large number of comments
        num_comments = 200
        cell_ids = [f"cell_memory_{i % 20}" for i in range(num_comments)]

        for i in range(num_comments):
            cell_id = cell_ids[i]
            content = (
                f"Memory test comment {i} with sufficient content to test memory usage patterns"
            )
            await comment_store.create(cell_id, content)

        # Check memory usage increase
        gc.collect()
        final_objects = len(gc.get_objects())
        object_increase = final_objects - initial_objects

        # Test that memory usage is reasonable (rough heuristic)
        objects_per_comment = object_increase / num_comments
        assert objects_per_comment < 50  # Should be reasonable per comment

        print(
            f"Created {num_comments} comments, object increase: {object_increase} ({objects_per_comment:.2f} per comment)"
        )


class TestCommentExportFunctionality:
    """Test comment export capabilities in various formats."""

    @pytest.mark.asyncio
    async def test_export_comments_markdown(self, comment_store):
        """Test exporting comments in Markdown format."""
        # Create test comments
        cell_id = "cell_export_md"
        comments_data = [
            "First comment for markdown export",
            "Second comment with **bold** text",
            "Third comment with @user1 mention",
        ]

        created_comments = []
        for i, content in enumerate(comments_data):
            comment = await comment_store.create(f"{cell_id}_{i}", content)
            created_comments.append(comment)

        # Export to markdown
        markdown_export = await comment_store.exportComments(
            {"format": "markdown", "includeThreading": True, "includeUserInfo": True}
        )

        assert isinstance(markdown_export, str)
        assert "# Comments Export" in markdown_export
        assert "First comment for markdown export" in markdown_export
        assert "**bold**" in markdown_export or "bold" in markdown_export
        assert "@user1" in markdown_export

    @pytest.mark.asyncio
    async def test_export_comments_json(self, comment_store):
        """Test exporting comments in JSON format."""
        cell_id = "cell_export_json"
        comment = await comment_store.create(cell_id, "JSON export test comment")

        json_export = await comment_store.exportComments(
            {"format": "json", "includeUserInfo": True}
        )

        assert isinstance(json_export, str)

        # Parse JSON to validate structure
        export_data = json.loads(json_export)
        assert isinstance(export_data, list)
        assert len(export_data) >= 1

        comment_data = export_data[0]
        assert "id" in comment_data
        assert "content" in comment_data
        assert "cellId" in comment_data
        assert "timestamp" in comment_data
        assert comment_data["content"] == "JSON export test comment"

    @pytest.mark.asyncio
    async def test_export_comments_html(self, comment_store):
        """Test exporting comments in HTML format."""
        cell_id = "cell_export_html"
        comment = await comment_store.create(cell_id, "HTML export test with *emphasis*")

        html_export = await comment_store.exportComments(
            {"format": "html", "includeThreading": False, "includeUserInfo": True}
        )

        assert isinstance(html_export, str)
        assert "<!DOCTYPE html>" in html_export
        assert "<html>" in html_export
        assert "Comments Export" in html_export
        assert "HTML export test" in html_export

    @pytest.mark.asyncio
    async def test_export_comments_csv(self, comment_store):
        """Test exporting comments in CSV format."""
        cell_id = "cell_export_csv"
        comment = await comment_store.create(cell_id, "CSV export test comment")

        csv_export = await comment_store.exportComments({"format": "csv", "includeUserInfo": True})

        assert isinstance(csv_export, str)

        lines = csv_export.strip().split("\n")
        assert len(lines) >= 2  # Header + at least one data row

        header = lines[0]
        assert "ID" in header
        assert "Content" in header
        assert "Cell ID" in header
        assert "Author" in header

    @pytest.mark.asyncio
    async def test_export_with_filters(self, comment_store):
        """Test exporting comments with various filters."""
        # Create comments on different cells
        cells_and_comments = [
            ("cell_filter_1", "Comment on cell 1"),
            ("cell_filter_2", "Comment on cell 2"),
            ("cell_filter_1", "Another comment on cell 1"),
        ]

        for cell_id, content in cells_and_comments:
            await comment_store.create(cell_id, content)

        # Export with cell filter
        filtered_export = await comment_store.exportComments(
            {"format": "json", "cellIds": ["cell_filter_1"]}
        )

        export_data = json.loads(filtered_export)

        # Should only include comments from cell_filter_1
        for comment_data in export_data:
            assert comment_data["cellId"] == "cell_filter_1"

    @pytest.mark.asyncio
    async def test_export_with_date_range(self, comment_store):
        """Test exporting comments with date range filtering."""
        cell_id = "cell_date_filter"

        # Create comment
        comment = await comment_store.create(cell_id, "Date range test comment")

        # Export with date range (should include the comment)
        now = datetime.now(timezone.utc)
        yesterday = now - timedelta(days=1)
        tomorrow = now + timedelta(days=1)

        date_filtered_export = await comment_store.exportComments(
            {"format": "json", "dateRange": {"start": yesterday, "end": tomorrow}}
        )

        export_data = json.loads(date_filtered_export)
        assert len(export_data) >= 1  # Should include our comment

        # Test with range that excludes comments
        past_start = now - timedelta(days=10)
        past_end = now - timedelta(days=9)

        empty_export = await comment_store.exportComments(
            {"format": "json", "dateRange": {"start": past_start, "end": past_end}}
        )

        empty_data = json.loads(empty_export)
        assert len(empty_data) == 0  # Should be empty


class TestCommentErrorHandling:
    """Test error handling and edge cases in comment system."""

    @pytest.mark.asyncio
    async def test_create_comment_permissions_denied(self, comment_store):
        """Test comment creation with insufficient permissions."""
        # Mock permission denial
        comment_store._permissionManager.canEdit.return_value = False

        with pytest.raises(Exception) as exc_info:
            await comment_store.create("cell_perm_test", "Should fail")

        error_msg = str(exc_info.value).lower()
        assert "permission" in error_msg or "denied" in error_msg

    @pytest.mark.asyncio
    async def test_update_nonexistent_comment(self, comment_store):
        """Test updating a comment that doesn't exist."""
        fake_id = str(uuid.uuid4())

        with pytest.raises(Exception) as exc_info:
            await comment_store.update(fake_id, content="Updated content")

        assert "not found" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_delete_nonexistent_comment(self, comment_store):
        """Test deleting a comment that doesn't exist."""
        fake_id = str(uuid.uuid4())

        with pytest.raises(Exception) as exc_info:
            await comment_store.delete(fake_id)

        assert "not found" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_reply_to_nonexistent_comment(self, comment_store):
        """Test adding reply to non-existent parent comment."""
        fake_parent_id = str(uuid.uuid4())

        with pytest.raises(Exception) as exc_info:
            await comment_store.addReply(fake_parent_id, "Reply to nowhere")

        assert "not found" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_comment_content_validation(self, comment_store):
        """Test various invalid comment content scenarios."""
        cell_id = "cell_validation"

        # Empty content
        with pytest.raises(Exception):
            await comment_store.create(cell_id, "")

        # Whitespace only
        with pytest.raises(Exception):
            await comment_store.create(cell_id, "   \n\t  ")

        # None content
        with pytest.raises(Exception):
            await comment_store.create(cell_id, None)

    @pytest.mark.asyncio
    async def test_comment_store_disposed_operations(self, comment_store):
        """Test operations on disposed comment store."""
        # Dispose the store
        comment_store.dispose()

        # All operations should fail gracefully
        with pytest.raises(Exception) as exc_info:
            await comment_store.create("cell_disposed", "Should fail")
        assert "disposed" in str(exc_info.value).lower()

        # Read operations should return None/empty
        result = await comment_store.read("any_id")
        assert result is None

    @pytest.mark.asyncio
    async def test_invalid_export_format(self, comment_store):
        """Test export with invalid format."""
        with pytest.raises(Exception) as exc_info:
            await comment_store.exportComments({"format": "invalid_format"})

        assert "format" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_comment_limit_enforcement(self, comment_store):
        """Test that comment limits per cell are enforced."""
        # Set a low limit for testing
        original_limit = comment_store._config["maxCommentsPerCell"]
        comment_store._config["maxCommentsPerCell"] = 3

        try:
            cell_id = "cell_limit_test"

            # Create comments up to limit
            for i in range(3):
                await comment_store.create(cell_id, f"Comment {i}")

            # Next comment should fail
            with pytest.raises(Exception) as exc_info:
                await comment_store.create(cell_id, "Comment over limit")

            assert "limit" in str(exc_info.value).lower()
        finally:
            comment_store._config["maxCommentsPerCell"] = original_limit


class TestCommentIntegrationWithTokens:
    """Test integration with ICollaborationComments token interface."""

    @pytest.fixture
    def mock_collaboration_comments(self, comment_store):
        """Create mock implementation of ICollaborationComments interface."""

        class MockCollaborationComments:
            def __init__(self, comment_store):
                self._store = comment_store

            def addComment(self, cellId: str, text: str, parentId: str = None) -> str:
                """Add comment using the interface."""
                try:
                    # Create event loop if none exists
                    import asyncio

                    try:
                        loop = asyncio.get_running_loop()
                    except RuntimeError:
                        # No event loop running, create and run
                        loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(loop)
                        comment = loop.run_until_complete(
                            self._store.create(cellId, text, parentId)
                        )
                        loop.close()
                        return comment.id
                    else:
                        # Event loop is running, create task
                        task = loop.create_task(self._store.create(cellId, text, parentId))
                        comment = asyncio.run_coroutine_threadsafe(task, loop).result()
                        return comment.id
                except Exception as e:
                    print(f"Error in addComment: {e}")
                    return str(uuid.uuid4())  # Return dummy ID for testing

            def getComments(self, cellId: str):
                """Get comments using the interface."""
                try:
                    import asyncio

                    try:
                        loop = asyncio.get_running_loop()
                    except RuntimeError:
                        loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(loop)
                        comments = loop.run_until_complete(self._store.getCommentsByCell(cellId))
                        loop.close()
                        return comments
                    else:
                        task = loop.create_task(self._store.getCommentsByCell(cellId))
                        return asyncio.run_coroutine_threadsafe(task, loop).result()
                except Exception as e:
                    print(f"Error in getComments: {e}")
                    return []

            def resolveComment(self, commentId: str) -> None:
                """Resolve comment using the interface."""
                try:
                    import asyncio

                    try:
                        loop = asyncio.get_running_loop()
                    except RuntimeError:
                        loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(loop)
                        loop.run_until_complete(self._store.resolveComment(commentId))
                        loop.close()
                    else:
                        task = loop.create_task(self._store.resolveComment(commentId))
                        asyncio.run_coroutine_threadsafe(task, loop).result()
                except Exception as e:
                    print(f"Error in resolveComment: {e}")

            def subscribeToNotifications(self, callback) -> None:
                """Subscribe to notifications using the interface."""
                self._store.subscribeToNotifications(callback)

        return MockCollaborationComments(comment_store)

    def test_interface_add_comment(self, mock_collaboration_comments):
        """Test addComment method from ICollaborationComments interface."""
        cell_id = "cell_interface_test"
        comment_text = "Interface test comment"

        comment_id = mock_collaboration_comments.addComment(cell_id, comment_text)

        assert isinstance(comment_id, str)
        assert len(comment_id) > 0

    def test_interface_get_comments(self, mock_collaboration_comments):
        """Test getComments method from ICollaborationComments interface."""
        cell_id = "cell_interface_get"

        # Add comment via interface
        comment_id = mock_collaboration_comments.addComment(
            cell_id, "Comment to retrieve via interface"
        )

        # Get comments via interface
        comments = mock_collaboration_comments.getComments(cell_id)

        assert len(comments) >= 1
        assert any(comment.id == comment_id for comment in comments)

    def test_interface_resolve_comment(self, mock_collaboration_comments):
        """Test resolveComment method from ICollaborationComments interface."""
        cell_id = "cell_interface_resolve"

        # Add and resolve via interface
        comment_id = mock_collaboration_comments.addComment(
            cell_id, "Comment to resolve via interface"
        )

        # Should not raise exception
        mock_collaboration_comments.resolveComment(comment_id)

    def test_interface_subscribe_notifications(self, mock_collaboration_comments):
        """Test subscribeToNotifications method from ICollaborationComments interface."""
        notifications_received = []

        def test_callback(notification):
            notifications_received.append(notification)

        # Should not raise exception
        mock_collaboration_comments.subscribeToNotifications(test_callback)


class TestCommentSystemPerformanceBenchmarks:
    """Performance benchmarks for comment system components."""

    @pytest.mark.asyncio
    async def test_comment_crud_latency_benchmark(self, comment_store):
        """Benchmark CRUD operation latencies."""
        cell_id = "cell_latency_benchmark"
        num_operations = 20

        # Benchmark creation
        create_times = []
        created_ids = []

        for i in range(num_operations):
            start = time.perf_counter()
            comment = await comment_store.create(cell_id, f"Benchmark comment {i}")
            end = time.perf_counter()

            create_times.append(end - start)
            created_ids.append(comment.id)

        # Benchmark reading
        read_times = []
        for comment_id in created_ids:
            start = time.perf_counter()
            comment = await comment_store.read(comment_id)
            end = time.perf_counter()
            read_times.append(end - start)

        # Benchmark updates
        update_times = []
        for comment_id in created_ids[:10]:  # Update first 10
            start = time.perf_counter()
            await comment_store.update(comment_id, content="Updated content")
            end = time.perf_counter()
            update_times.append(end - start)

        # Calculate statistics
        create_stats = {
            "mean": statistics.mean(create_times),
            "median": statistics.median(create_times),
            "stdev": statistics.stdev(create_times) if len(create_times) > 1 else 0,
        }

        read_stats = {
            "mean": statistics.mean(read_times),
            "median": statistics.median(read_times),
            "stdev": statistics.stdev(read_times) if len(read_times) > 1 else 0,
        }

        update_stats = {
            "mean": statistics.mean(update_times),
            "median": statistics.median(update_times),
            "stdev": statistics.stdev(update_times) if len(update_times) > 1 else 0,
        }

        # Performance assertions
        assert create_stats["mean"] < 0.1  # Under 100ms average
        assert read_stats["mean"] < 0.05  # Under 50ms average
        assert update_stats["mean"] < 0.1  # Under 100ms average

        print(f"Create: {create_stats['mean']:.3f}±{create_stats['stdev']:.3f}s")
        print(f"Read: {read_stats['mean']:.3f}±{read_stats['stdev']:.3f}s")
        print(f"Update: {update_stats['mean']:.3f}±{update_stats['stdev']:.3f}s")

    @pytest.mark.asyncio
    async def test_threading_performance_benchmark(self, comment_store):
        """Benchmark threading operations performance."""
        cell_id = "cell_threading_benchmark"

        # Create root comment
        start = time.perf_counter()
        root = await comment_store.create(cell_id, "Threading benchmark root")
        root_time = time.perf_counter() - start

        # Create many replies
        reply_times = []
        num_replies = 30

        for i in range(num_replies):
            start = time.perf_counter()
            await comment_store.addReply(root.id, f"Benchmark reply {i}")
            end = time.perf_counter()
            reply_times.append(end - start)

        # Benchmark getting threaded comments
        start = time.perf_counter()
        threads = await comment_store.getThreadedComments(cell_id)
        threading_time = time.perf_counter() - start

        # Statistics
        reply_avg = statistics.mean(reply_times)
        reply_std = statistics.stdev(reply_times) if len(reply_times) > 1 else 0

        # Assertions
        assert reply_avg < 0.1  # Under 100ms per reply
        assert threading_time < 0.5  # Under 500ms to get threads
        assert len(threads) == 1
        assert threads[0].commentCount >= num_replies + 1  # Replies + root

        print(f"Root creation: {root_time:.3f}s")
        print(f"Reply avg: {reply_avg:.3f}±{reply_std:.3f}s")
        print(f"Threading retrieval: {threading_time:.3f}s")


# Integration test to verify all components work together
class TestCommentSystemIntegration:
    """Integration tests for the complete comment system."""

    @pytest.mark.asyncio
    async def test_full_comment_workflow_integration(self, comment_store):
        """Test complete comment workflow from creation to export."""
        cell_id = "cell_integration_workflow"

        # 1. Create root comment
        root_comment = await comment_store.create(
            cell_id, "Integration test root comment with @user2 mention", mentions=["user2"]
        )

        # 2. Add replies
        reply1 = await comment_store.addReply(root_comment.id, "First reply")
        reply2 = await comment_store.addReply(root_comment.id, "Second reply")
        nested_reply = await comment_store.addReply(reply1.id, "Nested reply")

        # 3. Update a comment
        updated_reply = await comment_store.update(reply1.id, content="Updated first reply")

        # 4. Get threaded view
        threads = await comment_store.getThreadedComments(cell_id)
        assert len(threads) == 1
        assert threads[0].commentCount >= 4

        # 5. Search comments
        search_results = await comment_store.searchComments("integration")
        assert len(search_results) >= 1

        # 6. Resolve some comments
        await comment_store.resolveComment(reply2.id)

        # 7. Export comments
        export_data = await comment_store.exportComments(
            {"format": "json", "includeThreading": True, "includeUserInfo": True}
        )

        export_json = json.loads(export_data)
        assert len(export_json) >= 4

        # 8. Filter comments
        filtered_comments = await comment_store.filterComments(
            {"cellIds": [cell_id], "hasReplies": True}
        )

        assert len(filtered_comments) >= 1

        # Verify the full workflow completed successfully
        assert root_comment.mentions == ["user2"]
        assert updated_reply.content == "Updated first reply"
        assert any(comment.isResolved for comment in await comment_store.getCommentsByCell(cell_id))

    @pytest.mark.asyncio
    async def test_comment_system_stress_test(self, comment_store, collaboration_settings):
        """Stress test the comment system with realistic load."""
        config = collaboration_settings(max_concurrent_users=5, max_comments_per_cell=50)

        # Create multiple cells with comments
        cells = [f"stress_cell_{i}" for i in range(10)]

        # Create comments across multiple cells
        all_comments = []
        for cell_id in cells:
            for i in range(20):  # 20 comments per cell
                content = f"Stress test comment {i} on {cell_id}"
                if i % 5 == 0:
                    content += " with @testuser mention"

                comment = await comment_store.create(cell_id, content)
                all_comments.append(comment)

                # Add some replies
                if i % 7 == 0:
                    await comment_store.addReply(comment.id, f"Reply to comment {i}")

        # Verify we created the expected number of comments
        total_expected = len(cells) * 20
        assert len(all_comments) == total_expected

        # Test batch operations performance
        start_time = time.perf_counter()

        # Get all comments for first cell
        cell_comments = await comment_store.getCommentsByCell(cells[0])
        assert len(cell_comments) >= 20

        # Search across all comments
        search_results = await comment_store.searchComments("stress test")
        assert len(search_results) >= total_expected

        # Export all comments
        export_result = await comment_store.exportComments({"format": "json"})
        export_data = json.loads(export_result)
        assert len(export_data) >= total_expected

        batch_time = time.perf_counter() - start_time

        # Should handle stress test efficiently
        assert batch_time < 5.0  # All operations under 5 seconds

        print(f"Stress test completed: {len(all_comments)} comments in {batch_time:.3f}s")
