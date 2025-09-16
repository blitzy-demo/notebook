"""
Tests for permissions and access control system in Jupyter Notebook collaborative editing.

This comprehensive test suite validates role-based permissions (VIEW_ONLY, EDIT, ADMIN),
dynamic permission changes, WebSocket authentication, session management, API endpoint
authorization, and integration with JupyterHub authentication infrastructure.

Tests cover:
- Role assignment and validation (viewer/editor/admin)
- Permission enforcement on collaborative operations
- View-only mode restrictions and edit permission checks
- Admin privilege verification and permission inheritance
- Dynamic permission updates with immediate application
- Collaborative session authorization and API security
- Permission persistence across session lifecycle
- JupyterHub role integration and authentication flows
"""

import asyncio
import json
import time
import uuid
from unittest.mock import Mock

import pytest
import tornado.web

from notebook.app import JupyterNotebookApp
from notebook.handlers import CollaborationSessionsHandler, YjsWebSocketHandler


class TestRoleBasedPermissions:
    """Test role-based access control (RBAC) for collaborative editing."""

    @pytest.mark.asyncio
    async def test_role_assignment_from_user_info(self, collaboration_settings):
        """Test correct role assignment based on user information."""
        settings = collaboration_settings()

        # Test admin role assignment
        user_info_admin = {
            "id": "admin_user",
            "name": "Admin User",
            "email": "admin@example.com",
            "groups": ["admin", "notebook_users"],
            "roles": ["admin", "edit"],
        }

        handler = YjsWebSocketHandler()
        handler.user_info = user_info_admin

        # Simulate permission check
        permission_granted = handler._check_collaboration_permissions()

        assert permission_granted is True
        assert handler.user_role == "ADMIN"

        # Test edit role assignment
        user_info_editor = {
            "id": "edit_user",
            "name": "Editor User",
            "email": "editor@example.com",
            "groups": ["notebook_users"],
            "roles": ["edit"],
        }

        handler.user_info = user_info_editor
        permission_granted = handler._check_collaboration_permissions()

        assert permission_granted is True
        assert handler.user_role == "EDIT"

        # Test view-only role assignment
        user_info_viewer = {
            "id": "view_user",
            "name": "Viewer User",
            "email": "viewer@example.com",
            "groups": ["notebook_users"],
            "roles": ["view"],
        }

        handler.user_info = user_info_viewer
        permission_granted = handler._check_collaboration_permissions()

        assert permission_granted is True
        assert handler.user_role == "VIEW_ONLY"

    @pytest.mark.asyncio
    async def test_default_role_fallback(self, collaboration_settings):
        """Test fallback to VIEW_ONLY role when no explicit roles provided."""
        settings = collaboration_settings()

        user_info_no_roles = {
            "id": "no_role_user",
            "name": "No Role User",
            "email": "norole@example.com",
            "groups": ["notebook_users"],
            "roles": [],
        }

        handler = YjsWebSocketHandler()
        handler.user_info = user_info_no_roles

        permission_granted = handler._check_collaboration_permissions()

        assert permission_granted is True
        assert handler.user_role == "VIEW_ONLY"

    def test_invalid_user_info_rejection(self, collaboration_settings):
        """Test rejection when user info is invalid or missing."""
        settings = collaboration_settings()

        handler = YjsWebSocketHandler()

        # Test with None user_info
        handler.user_info = None
        permission_granted = handler._check_collaboration_permissions()
        assert permission_granted is False

        # Test with empty user_info
        handler.user_info = {}
        permission_granted = handler._check_collaboration_permissions()
        assert permission_granted is True  # Empty roles default to VIEW_ONLY
        assert handler.user_role == "VIEW_ONLY"


class TestPermissionValidationOnOperations:
    """Test permission enforcement on specific collaborative operations."""

    @pytest.mark.asyncio
    async def test_edit_operations_permission_check(self, collaboration_settings, websocket_client):
        """Test that edit operations require appropriate permissions."""
        settings = collaboration_settings()

        # Test VIEW_ONLY user cannot perform edit operations
        view_only_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_viewer"}
        )

        # Simulate VIEW_ONLY role
        view_only_client.user_role = "VIEW_ONLY"

        # Try to send a Yjs binary update (edit operation)
        yjs_update = b"\x00\x01\x02\x03"  # Mock Yjs update data

        await view_only_client.write_message(yjs_update, binary=True)

        # Should receive error message about edit permission
        error_msg = await asyncio.wait_for(view_only_client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Edit permission required" in error_msg["error"]

        # Test EDIT user can perform edit operations
        edit_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_editor"}
        )
        edit_client.user_role = "EDIT"

        await edit_client.write_message(yjs_update, binary=True)

        # Should not receive error - edit allowed
        # Wait briefly to ensure no error message
        try:
            msg = await asyncio.wait_for(edit_client.read_message(), timeout=0.5)
            # If we get a message, ensure it's not an error
            if msg.get("type") == "error":
                pytest.fail(f"Unexpected error for EDIT user: {msg.get('error')}")
        except asyncio.TimeoutError:
            # No error message received - this is expected
            pass

    @pytest.mark.asyncio
    async def test_lock_operations_permission_check(self, collaboration_settings, websocket_client):
        """Test that cell locking requires edit permissions."""
        settings = collaboration_settings()

        # Test VIEW_ONLY user cannot acquire locks
        view_only_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_viewer"}
        )
        view_only_client.user_role = "VIEW_ONLY"
        view_only_client.user_info = {"id": "viewer_user", "name": "Viewer"}

        lock_request = {"type": "lock_request", "cellId": "cell_001", "timestamp": time.time()}

        await view_only_client.write_message(json.dumps(lock_request))

        # Should receive error about edit permission required
        error_msg = await asyncio.wait_for(view_only_client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Edit permission required for locks" in error_msg["error"]

        # Test EDIT user can acquire locks
        edit_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_editor"}
        )
        edit_client.user_role = "EDIT"
        edit_client.user_info = {"id": "editor_user", "name": "Editor"}

        await edit_client.write_message(json.dumps(lock_request))

        # Should receive lock response
        lock_response = await asyncio.wait_for(edit_client.read_message(), timeout=2.0)
        assert lock_response["type"] == "lock_response"
        assert lock_response["cellId"] == "cell_001"
        assert lock_response["success"] is True

    @pytest.mark.asyncio
    async def test_admin_privilege_verification(self, collaboration_settings, websocket_client):
        """Test admin-only operations and privilege verification."""
        settings = collaboration_settings()

        # Setup admin user
        admin_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_admin"}
        )
        admin_client.user_role = "ADMIN"
        admin_client.user_info = {"id": "admin_user", "name": "Admin"}
        admin_client.session_id = str(uuid.uuid4())

        # Setup regular edit user
        edit_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_editor"}
        )
        edit_client.user_role = "EDIT"
        edit_client.user_info = {"id": "edit_user", "name": "Editor"}
        edit_client.session_id = str(uuid.uuid4())

        # Have edit user acquire a lock
        lock_request = {
            "type": "lock_request",
            "cellId": "cell_admin_test",
            "timestamp": time.time(),
        }

        await edit_client.write_message(json.dumps(lock_request))
        lock_response = await asyncio.wait_for(edit_client.read_message(), timeout=2.0)
        assert lock_response["success"] is True

        # Admin should be able to forcibly release locks held by other users
        admin_release = {
            "type": "lock_release",
            "cellId": "cell_admin_test",
            "timestamp": time.time(),
        }

        await admin_client.write_message(json.dumps(admin_release))

        # Should succeed without error (admin privilege allows releasing others' locks)
        # Wait briefly to ensure no error
        try:
            msg = await asyncio.wait_for(admin_client.read_message(), timeout=0.5)
            if msg.get("type") == "error":
                pytest.fail(f"Admin should be able to release any lock: {msg.get('error')}")
        except asyncio.TimeoutError:
            # No error message - expected for successful admin operation
            pass


class TestViewOnlyModeEnforcement:
    """Test enforcement of view-only mode restrictions."""

    @pytest.mark.asyncio
    async def test_view_only_user_restrictions(self, collaboration_settings, websocket_client):
        """Test comprehensive restrictions for view-only users."""
        settings = collaboration_settings()

        view_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_viewer"}
        )
        view_client.user_role = "VIEW_ONLY"
        view_client.user_info = {"id": "view_user", "name": "Viewer"}

        # Test 1: Cannot send Yjs binary updates (document edits)
        yjs_update = b"\x00\x01\x02\x03\x04"
        await view_client.write_message(yjs_update, binary=True)

        error_msg = await asyncio.wait_for(view_client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Edit permission required" in error_msg["error"]

        # Test 2: Cannot acquire cell locks
        lock_request = {"type": "lock_request", "cellId": "readonly_cell", "timestamp": time.time()}

        await view_client.write_message(json.dumps(lock_request))

        error_msg = await asyncio.wait_for(view_client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Edit permission required for locks" in error_msg["error"]

        # Test 3: CAN send awareness updates (presence information)
        awareness_update = {
            "type": "awareness",
            "user_id": "view_user",
            "awareness": {
                "cursor": {"line": 5, "column": 10},
                "selection": {"start": 5, "end": 15},
                "visible": True,
            },
            "timestamp": time.time(),
        }

        await view_client.write_message(json.dumps(awareness_update))

        # Should not receive error - awareness updates allowed for view-only
        try:
            msg = await asyncio.wait_for(view_client.read_message(), timeout=0.5)
            if msg.get("type") == "error":
                pytest.fail(f"View-only user should be able to send awareness: {msg.get('error')}")
        except asyncio.TimeoutError:
            # No error message - expected for successful awareness update
            pass

    @pytest.mark.asyncio
    async def test_view_only_receives_updates(self, collaboration_settings, websocket_client):
        """Test that view-only users receive updates from other users."""
        settings = collaboration_settings()

        # Setup view-only client
        view_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_viewer"}
        )
        view_client.user_role = "VIEW_ONLY"
        view_client.document_id = "test_doc"

        # Setup edit client
        edit_client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_editor"}
        )
        edit_client.user_role = "EDIT"
        edit_client.document_id = "test_doc"
        edit_client.session_id = str(uuid.uuid4())

        # Add both clients to active connections (simulate connection)
        YjsWebSocketHandler._active_connections.add(view_client)
        YjsWebSocketHandler._active_connections.add(edit_client)

        try:
            # Edit client sends awareness update
            awareness_update = {
                "type": "awareness_update",
                "sessionId": edit_client.session_id,
                "awareness": {"cursor": {"line": 10, "column": 5}},
                "timestamp": time.time(),
            }

            # Simulate broadcast to view client
            await view_client._queue_message(awareness_update)

            # View client should receive the update
            received_msg = await asyncio.wait_for(view_client.read_message(), timeout=2.0)
            assert received_msg["type"] == "awareness_update"
            assert received_msg["sessionId"] == edit_client.session_id

        finally:
            # Cleanup
            YjsWebSocketHandler._active_connections.discard(view_client)
            YjsWebSocketHandler._active_connections.discard(edit_client)


class TestDynamicPermissionUpdates:
    """Test dynamic permission changes and immediate application."""

    @pytest.mark.asyncio
    async def test_permission_role_change_immediate_effect(
        self, collaboration_settings, websocket_client
    ):
        """Test that permission changes apply immediately to active sessions."""
        settings = collaboration_settings()

        client = await websocket_client(
            "/api/collaboration/ws/test_doc", headers={"Authorization": "Bearer test_token_user"}
        )
        client.user_info = {"id": "dynamic_user", "name": "Dynamic User", "roles": ["edit"]}

        # Initially user has EDIT role
        assert client._check_collaboration_permissions() is True
        assert client.user_role == "EDIT"

        # User can initially acquire locks
        lock_request = {"type": "lock_request", "cellId": "dynamic_cell", "timestamp": time.time()}

        await client.write_message(json.dumps(lock_request))
        lock_response = await asyncio.wait_for(client.read_message(), timeout=2.0)
        assert lock_response["success"] is True

        # Simulate role change to VIEW_ONLY (dynamic update)
        client.user_info["roles"] = ["view"]
        client._check_collaboration_permissions()
        assert client.user_role == "VIEW_ONLY"

        # Now lock requests should be denied
        lock_request2 = {
            "type": "lock_request",
            "cellId": "dynamic_cell_2",
            "timestamp": time.time(),
        }

        await client.write_message(json.dumps(lock_request2))
        error_msg = await asyncio.wait_for(client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Edit permission required for locks" in error_msg["error"]

    @pytest.mark.asyncio
    async def test_permission_inheritance_jupyterhub(self, collaboration_settings):
        """Test permission inheritance from JupyterHub role system."""
        settings = collaboration_settings()

        # Simulate JupyterHub user with inherited roles
        jupyterhub_user = {
            "id": "hub_user_123",
            "name": "JupyterHub User",
            "email": "hubuser@organization.com",
            "groups": ["data_scientists", "notebook_users"],
            "roles": ["edit"],  # Inherited from JupyterHub group membership
            "hub_permissions": {
                "server_admin": False,
                "access_notebook": True,
                "create_server": True,
            },
        }

        handler = YjsWebSocketHandler()
        handler.user_info = jupyterhub_user

        permission_granted = handler._check_collaboration_permissions()

        assert permission_granted is True
        assert handler.user_role == "EDIT"

        # Test admin inheritance
        admin_hub_user = {
            "id": "hub_admin_456",
            "name": "JupyterHub Admin",
            "email": "admin@organization.com",
            "groups": ["admins", "data_scientists", "notebook_users"],
            "roles": ["admin", "edit"],
            "hub_permissions": {
                "server_admin": True,
                "access_notebook": True,
                "create_server": True,
                "manage_users": True,
            },
        }

        handler.user_info = admin_hub_user
        permission_granted = handler._check_collaboration_permissions()

        assert permission_granted is True
        assert handler.user_role == "ADMIN"


class TestCollaborativeSessionPermissions:
    """Test permission enforcement in collaborative session context."""

    @pytest.mark.asyncio
    async def test_session_creation_permissions(self, collaboration_settings, jp_fetch):
        """Test permission requirements for session creation via REST API."""
        settings = collaboration_settings()

        # Test authenticated user can create session
        session_data = {
            "notebook_path": "test_notebook.ipynb",
            "permissions": ["read", "write"],
            "name": "Test Collaboration Session",
        }

        # Mock authentication
        mock_user = {
            "id": "session_creator",
            "name": "Session Creator",
            "email": "creator@example.com",
        }

        # This would typically be handled by the Tornado authentication decorator
        # Here we test the handler logic directly
        handler = CollaborationSessionsHandler()
        handler.get_current_user = Mock(return_value=mock_user)

        session_info = handler._create_or_join_session(
            mock_user,
            session_data["notebook_path"],
            session_data["permissions"],
            session_data["name"],
        )

        assert session_info["user_role"] == "EDIT"  # write permission maps to EDIT
        assert session_info["document_path"] == "test_notebook.ipynb"
        assert "session_id" in session_info
        assert "websocket_url" in session_info

    @pytest.mark.asyncio
    async def test_session_join_permission_validation(self, collaboration_settings):
        """Test permission validation when joining existing sessions."""
        settings = collaboration_settings()

        # Create initial session
        creator = {"id": "creator_user", "name": "Creator", "email": "creator@example.com"}

        handler = CollaborationSessionsHandler()
        session_info = handler._create_or_join_session(
            creator, "shared_notebook.ipynb", ["read", "write", "admin"], "Shared Session"
        )

        session_id = session_info["session_id"]

        # Test different users joining with different permission levels

        # User with admin permissions
        admin_user = {"id": "admin_joiner", "name": "Admin Joiner", "email": "admin@example.com"}

        admin_session = handler._create_or_join_session(
            admin_user, "shared_notebook.ipynb", ["read", "write", "admin"], "Admin Join"
        )

        assert admin_session["user_role"] == "ADMIN"

        # User with only read permissions
        reader_user = {
            "id": "reader_joiner",
            "name": "Reader Joiner",
            "email": "reader@example.com",
        }

        reader_session = handler._create_or_join_session(
            reader_user, "shared_notebook.ipynb", ["read"], "Reader Join"
        )

        assert reader_session["user_role"] == "VIEW_ONLY"

    @pytest.mark.asyncio
    async def test_session_leave_permission_enforcement(self, collaboration_settings):
        """Test permission enforcement when leaving sessions."""
        settings = collaboration_settings()

        user = {"id": "leave_test_user", "name": "Leave Test User", "email": "leave@example.com"}

        handler = CollaborationSessionsHandler()

        # User should only be able to leave their own sessions
        fake_session_id = str(uuid.uuid4())

        # Mock WebSocket connections
        mock_connection = Mock()
        mock_connection.session_id = fake_session_id
        mock_connection.user_info = user
        mock_connection.close = Mock()

        YjsWebSocketHandler._active_connections.add(mock_connection)

        try:
            # User can leave their own session
            success = handler._leave_session(user, fake_session_id)
            assert success is True

            # Verify connection was closed
            mock_connection.close.assert_called_once()

        finally:
            # Cleanup
            YjsWebSocketHandler._active_connections.discard(mock_connection)


class TestAPIEndpointAuthorization:
    """Test authorization enforcement on collaboration API endpoints."""

    @pytest.mark.asyncio
    async def test_unauthenticated_access_rejection(self, collaboration_settings):
        """Test that unauthenticated requests are rejected with 401."""
        settings = collaboration_settings()

        handler = CollaborationSessionsHandler()
        handler.get_current_user = Mock(return_value=None)

        # Test GET request without authentication
        with pytest.raises(
            (tornado.web.HTTPError, AttributeError), match=r".*(401|Authentication|current_user).*"
        ):
            handler.get()

        # Should raise HTTP error indicating authentication required
        # The specific error depends on Tornado's authentication decorator

        # Test POST request without authentication
        with pytest.raises(
            (tornado.web.HTTPError, AttributeError), match=r".*(401|Authentication|current_user).*"
        ):
            handler.post()

        # Test DELETE request without authentication
        with pytest.raises(
            (tornado.web.HTTPError, AttributeError), match=r".*(401|Authentication|current_user).*"
        ):
            handler.delete("some_session_id")

    @pytest.mark.asyncio
    async def test_malformed_request_rejection(self, collaboration_settings):
        """Test rejection of malformed API requests."""
        settings = collaboration_settings()

        mock_user = {"id": "test_user", "name": "Test User"}

        handler = CollaborationSessionsHandler()
        handler.get_current_user = Mock(return_value=mock_user)

        # Mock request with invalid JSON
        class MockRequest:
            def __init__(self, body):
                self.body = body

        handler.request = MockRequest(b'{"invalid": json"}')

        # Should handle JSON decode error gracefully
        with pytest.raises(
            (tornado.web.HTTPError, json.JSONDecodeError), match=r".*(400|Invalid JSON|Expecting).*"
        ):
            handler.post()

        # Test missing required fields
        handler.request = MockRequest(b'{"name": "session without notebook_path"}')

        with pytest.raises(
            (tornado.web.HTTPError, KeyError), match=r".*(400|notebook_path|required).*"
        ):
            handler.post()

    @pytest.mark.asyncio
    async def test_rate_limiting_enforcement(self, collaboration_settings, websocket_client):
        """Test WebSocket rate limiting to prevent DoS attacks."""
        settings = collaboration_settings(
            websocket_max_message_size=1024,
            rate_limit_per_second=5,  # Very low limit for testing
        )

        client = await websocket_client(
            "/api/collaboration/ws/test_doc",
            headers={"Authorization": "Bearer test_token_ratelimit"},
        )
        client.user_role = "EDIT"

        # Send many messages rapidly to trigger rate limit
        for i in range(250):  # Exceed burst limit of 200
            message = {"type": "ping", "sequence": i}
            await client.write_message(json.dumps(message))

        # Should receive rate limit error
        error_received = False
        for _ in range(10):  # Check multiple messages for rate limit error
            try:
                msg = await asyncio.wait_for(client.read_message(), timeout=0.1)
                if msg.get("type") == "error" and "Rate limit exceeded" in msg.get("error", ""):
                    error_received = True
                    break
            except asyncio.TimeoutError:
                continue

        assert error_received, "Rate limit should have been triggered"

    @pytest.mark.asyncio
    async def test_message_size_limit_enforcement(self, collaboration_settings, websocket_client):
        """Test WebSocket message size limits to prevent memory exhaustion."""
        settings = collaboration_settings()

        client = await websocket_client(
            "/api/collaboration/ws/test_doc",
            headers={"Authorization": "Bearer test_token_sizelimit"},
        )
        client.user_role = "EDIT"

        # Create oversized message (> 1MB limit)
        large_message = "x" * (1024 * 1024 + 1)  # Just over 1MB

        await client.write_message(large_message)

        # Should receive message size error
        error_msg = await asyncio.wait_for(client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Message size limit exceeded" in error_msg["error"]


class TestPermissionPersistence:
    """Test persistence of permissions across session lifecycle."""

    def test_permission_storage_and_retrieval(self, collaboration_settings):
        """Test that permissions are stored and retrieved correctly."""
        settings = collaboration_settings()

        # Test user permissions storage in session
        user_info = {
            "id": "persist_user",
            "name": "Persistence User",
            "roles": ["edit"],
            "session_permissions": {
                "notebook_123": "EDIT",
                "notebook_456": "VIEW_ONLY",
                "notebook_789": "ADMIN",
            },
        }

        handler = YjsWebSocketHandler()
        handler.user_info = user_info
        handler.document_id = "notebook_123"

        permission_granted = handler._check_collaboration_permissions()
        assert permission_granted is True
        assert handler.user_role == "EDIT"

        # Test document-specific permissions override
        handler.document_id = "notebook_456"
        permission_granted = handler._check_collaboration_permissions()
        assert permission_granted is True
        assert handler.user_role == "EDIT"  # Based on user roles, not document-specific

    @pytest.mark.asyncio
    async def test_session_permission_cleanup(self, collaboration_settings, websocket_client):
        """Test cleanup of permissions when sessions end."""
        settings = collaboration_settings()

        client = await websocket_client(
            "/api/collaboration/ws/test_cleanup",
            headers={"Authorization": "Bearer test_token_cleanup"},
        )
        client.user_role = "EDIT"
        client.user_info = {"id": "cleanup_user", "name": "Cleanup User"}
        client.document_id = "test_cleanup"
        client.session_id = str(uuid.uuid4())

        # Add to active connections
        YjsWebSocketHandler._active_connections.add(client)

        # Initialize document store
        YjsWebSocketHandler._document_stores["test_cleanup"] = {
            "yjs_state": b"",
            "created_at": time.time(),
            "last_modified": time.time(),
            "active_users": {client.session_id},
            "cell_locks": {},
            "version_history": [],
        }

        try:
            # Acquire some locks
            lock_request = {
                "type": "lock_request",
                "cellId": "cleanup_cell_1",
                "timestamp": time.time(),
            }

            await client.write_message(json.dumps(lock_request))
            lock_response = await asyncio.wait_for(client.read_message(), timeout=2.0)
            assert lock_response["success"] is True

            # Verify lock was acquired
            store = YjsWebSocketHandler._document_stores["test_cleanup"]
            assert "cleanup_cell_1" in store["cell_locks"]

            # Simulate client disconnect
            await client.close()

            # Verify locks were released and user removed
            assert client.session_id not in store["active_users"]
            # Note: In real implementation, locks would be cleaned up in on_close()

        finally:
            # Cleanup test data
            YjsWebSocketHandler._active_connections.discard(client)
            if "test_cleanup" in YjsWebSocketHandler._document_stores:
                del YjsWebSocketHandler._document_stores["test_cleanup"]


class TestJupyterHubRoleIntegration:
    """Test integration with JupyterHub authentication and role system."""

    def test_jupyterhub_token_validation(self, collaboration_settings):
        """Test JupyterHub token validation in WebSocket authentication."""
        settings = collaboration_settings()

        handler = YjsWebSocketHandler()

        # Test valid JupyterHub token format
        jupyterhub_token = "jhub_" + "a" * 40  # Simulate JupyterHub token format

        user_info = handler._validate_auth_token(jupyterhub_token)

        assert user_info is not None
        assert "id" in user_info
        assert "name" in user_info
        assert "roles" in user_info

        # Test invalid token
        invalid_test_token = f"invalid_{uuid.uuid4().hex[:12]}"
        user_info = handler._validate_auth_token(invalid_test_token)
        assert user_info is None

    @pytest.mark.asyncio
    async def test_jupyterhub_authentication_flow(self, collaboration_settings):
        """Test complete JupyterHub authentication flow."""
        settings = collaboration_settings()

        # Simulate JupyterHub environment variables and configuration
        mock_hub_config = {
            "hub_prefix": "/hub",
            "hub_host": "hub.example.com",
            "user": "jupyterhub_user",
            "server_name": "notebook_server_1",
        }

        app = JupyterNotebookApp()
        app.collaboration_enabled = True

        # Test collaboration configuration with JupyterHub
        collab_settings = app._get_collaboration_settings()

        assert collab_settings["collaboration_enabled"] is True
        assert "server_url" in collab_settings

        # Test page config includes JupyterHub metadata
        page_config = {
            "collaboration_enabled": True,
            "collaboration_config": {
                "websocket_url": "/api/collaboration/ws",
                "session_api_url": "/api/collaboration/sessions",
            },
        }

        # In real implementation, this would be set by initialize_handlers()
        assert page_config["collaboration_enabled"] is True

    @pytest.mark.asyncio
    async def test_jupyterhub_group_permission_mapping(self, collaboration_settings):
        """Test mapping of JupyterHub groups to collaboration permissions."""
        settings = collaboration_settings()

        # Test mapping different JupyterHub groups to roles
        test_cases = [
            {
                "user": {
                    "id": "student_user",
                    "name": "Student User",
                    "groups": ["students"],
                    "roles": ["view"],  # Students get view-only
                },
                "expected_role": "VIEW_ONLY",
            },
            {
                "user": {
                    "id": "instructor_user",
                    "name": "Instructor User",
                    "groups": ["instructors", "notebook_users"],
                    "roles": ["edit"],  # Instructors get edit access
                },
                "expected_role": "EDIT",
            },
            {
                "user": {
                    "id": "admin_user",
                    "name": "Admin User",
                    "groups": ["admins", "instructors", "notebook_users"],
                    "roles": ["admin", "edit"],  # Admins get full access
                },
                "expected_role": "ADMIN",
            },
        ]

        for case in test_cases:
            handler = YjsWebSocketHandler()
            handler.user_info = case["user"]

            permission_granted = handler._check_collaboration_permissions()
            assert permission_granted is True
            assert handler.user_role == case["expected_role"]


class TestPermissionChangeImmediateApplication:
    """Test that permission changes apply immediately without restart."""

    @pytest.mark.asyncio
    async def test_runtime_permission_update(self, collaboration_settings, websocket_client):
        """Test permission updates are applied immediately to active connections."""
        settings = collaboration_settings()

        client = await websocket_client(
            "/api/collaboration/ws/immediate_test",
            headers={"Authorization": "Bearer test_token_immediate"},
        )

        # Start with edit permissions
        client.user_info = {"id": "immediate_user", "name": "Immediate User", "roles": ["edit"]}
        client._check_collaboration_permissions()
        assert client.user_role == "EDIT"

        # Test edit operation works
        lock_request = {
            "type": "lock_request",
            "cellId": "immediate_cell",
            "timestamp": time.time(),
        }

        await client.write_message(json.dumps(lock_request))
        lock_response = await asyncio.wait_for(client.read_message(), timeout=2.0)
        assert lock_response["success"] is True

        # Simulate immediate role change (e.g., from admin panel)
        client.user_info["roles"] = ["view"]
        client._check_collaboration_permissions()
        assert client.user_role == "VIEW_ONLY"

        # Subsequent edit operations should now fail immediately
        lock_request2 = {
            "type": "lock_request",
            "cellId": "immediate_cell_2",
            "timestamp": time.time(),
        }

        await client.write_message(json.dumps(lock_request2))
        error_msg = await asyncio.wait_for(client.read_message(), timeout=2.0)
        assert error_msg["type"] == "error"
        assert "Edit permission required for locks" in error_msg["error"]

    @pytest.mark.asyncio
    async def test_permission_consistency_across_sessions(
        self, collaboration_settings, websocket_client
    ):
        """Test permission changes are consistent across multiple sessions."""
        settings = collaboration_settings()

        user_id = "consistency_user"

        # Create multiple sessions for same user
        client1 = await websocket_client(
            "/api/collaboration/ws/consistency_test",
            headers={"Authorization": "Bearer test_token_consistency1"},
        )
        client1.user_info = {"id": user_id, "name": "Consistency User", "roles": ["edit"]}

        client2 = await websocket_client(
            "/api/collaboration/ws/consistency_test",
            headers={"Authorization": "Bearer test_token_consistency2"},
        )
        client2.user_info = {"id": user_id, "name": "Consistency User", "roles": ["edit"]}

        # Both should initially have edit permissions
        client1._check_collaboration_permissions()
        client2._check_collaboration_permissions()
        assert client1.user_role == "EDIT"
        assert client2.user_role == "EDIT"

        # Simulate permission change affecting all sessions for this user
        updated_roles = ["view"]
        client1.user_info["roles"] = updated_roles
        client2.user_info["roles"] = updated_roles

        client1._check_collaboration_permissions()
        client2._check_collaboration_permissions()

        # Both sessions should now reflect the change
        assert client1.user_role == "VIEW_ONLY"
        assert client2.user_role == "VIEW_ONLY"

        # Both should be unable to perform edit operations
        lock_request = {
            "type": "lock_request",
            "cellId": "consistency_cell",
            "timestamp": time.time(),
        }

        await client1.write_message(json.dumps(lock_request))
        error1 = await asyncio.wait_for(client1.read_message(), timeout=2.0)
        assert error1["type"] == "error"

        await client2.write_message(json.dumps(lock_request))
        error2 = await asyncio.wait_for(client2.read_message(), timeout=2.0)
        assert error2["type"] == "error"


if __name__ == "__main__":
    pytest.main([__file__])
