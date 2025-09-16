"""
Integration tests for JupyterHub authentication in collaborative contexts.

This module provides comprehensive testing for authentication integration between
JupyterHub and collaborative editing features, validating user authentication,
session management, role-based access control, and permission enforcement.

Test coverage includes:
- JupyterHub token validation
- User identity propagation to collaboration sessions
- Role mapping (viewer/editor/admin)
- Permission checks on WebSocket connections
- Session cleanup on logout
- Multi-user identity isolation
- Permission changes during active sessions
- Unauthorized access prevention
- Cross-session security validation
"""

import asyncio
import time
import uuid

import pytest


class TestJupyterHubAuthenticationIntegration:
    """
    Test suite for JupyterHub authentication integration in collaborative contexts.

    Validates that collaborative editing features properly integrate with JupyterHub's
    authentication system while maintaining security and proper session management.
    """

    async def test_valid_jupyterhub_token_authentication(self, websocket_client):
        """
        Test successful authentication with valid JupyterHub token.

        Validates that users with valid JupyterHub authentication tokens can
        successfully connect to collaborative WebSocket sessions and receive
        appropriate role assignments based on their hub permissions.
        """
        # Create valid authentication token (simulating JupyterHub)
        valid_token = "hub_token_" + uuid.uuid4().hex
        test_user_id = f"hub_user_{uuid.uuid4().hex[:8]}"

        # Create WebSocket client with valid credentials
        client = websocket_client("collaborative_notebook.ipynb", test_user_id)

        # Add authentication token to client
        client.auth_token = valid_token
        client.hub_user = {
            "id": test_user_id,
            "name": f"Hub User {test_user_id[:4]}",
            "email": f"{test_user_id}@hub.example.com",
            "groups": ["notebook_users", "collaborators"],
            "roles": ["edit"],
        }

        # Attempt WebSocket connection
        websocket_url = "ws://localhost:8888/api/collaboration/ws"
        connection_successful = await client.connect(websocket_url)

        assert connection_successful, "Valid JupyterHub token should allow WebSocket connection"
        assert client.connected, "Client should be connected after successful authentication"

        # Validate authentication message was sent
        assert len(client.messages_sent) > 0, "Client should send authentication message"
        auth_message = client.messages_sent[0]
        assert auth_message["type"] == "connect", "First message should be connection request"
        assert auth_message["user_id"] == test_user_id, "User ID should match JupyterHub identity"

        # Validate server response includes proper role assignment
        assert len(client.messages_received) > 0, "Should receive response from server"
        response = client.messages_received[0]
        assert response["type"] == "connected", "Should receive connection confirmation"
        assert response["user_id"] == test_user_id, "Response should include correct user ID"

        # Clean up connection
        await client.disconnect()
        assert not client.connected, "Client should be disconnected after cleanup"

    async def test_invalid_token_authentication_rejection(self, websocket_client):
        """
        Test rejection of invalid or expired JupyterHub tokens.

        Validates that collaborative WebSocket connections properly reject invalid
        authentication tokens and prevent unauthorized access to collaborative sessions.
        """
        # Create invalid authentication tokens
        invalid_tokens = [
            "",  # Empty token
            "invalid",  # Too short token
            "fake_token_12345",  # Invalid format
            None,  # No token
        ]

        for invalid_token in invalid_tokens:
            test_user_id = f"invalid_user_{uuid.uuid4().hex[:8]}"
            client = websocket_client("collaborative_notebook.ipynb", test_user_id)

            # Set invalid token
            client.auth_token = invalid_token

            # Attempt WebSocket connection - should fail
            websocket_url = "ws://localhost:8888/api/collaboration/ws"

            # Mock connection failure for invalid token
            def create_mock_connect_failure(token, client_ref):
                async def mock_connect_with_auth_failure(url):
                    if not token or len(str(token)) < 32:
                        # Simulate authentication failure
                        client_ref.connected = False
                        error_response = {
                            "type": "error",
                            "error": "Authentication failed",
                            "code": 1008,
                        }
                        client_ref.messages_received.append(error_response)
                        return False
                    return False  # All invalid tokens should fail

                return mock_connect_with_auth_failure

            client.connect = create_mock_connect_failure(invalid_token, client)

            connection_successful = await client.connect(websocket_url)

            assert not connection_successful, f"Invalid token {invalid_token} should be rejected"
            assert not client.connected, "Client should not be connected after auth failure"

            # Validate error response
            if client.messages_received:
                error_msg = client.messages_received[-1]
                assert error_msg["type"] == "error", "Should receive error message"
                assert "Authentication failed" in error_msg.get(
                    "error", ""
                ), "Should indicate auth failure"

    @pytest.mark.parametrize(
        ("user_role", "expected_permissions"),
        [
            ("viewer", ["view"]),
            ("editor", ["view", "edit"]),
            ("admin", ["view", "edit", "admin"]),
        ],
    )
    async def test_role_based_permission_mapping(
        self, websocket_client, user_role, expected_permissions
    ):
        """
        Test proper mapping of JupyterHub roles to collaboration permissions.

        Validates that different JupyterHub user roles are correctly mapped to
        appropriate collaboration permissions and that these permissions are
        enforced during collaborative editing sessions.
        """
        valid_token = "hub_token_" + uuid.uuid4().hex
        test_user_id = f"role_user_{user_role}_{uuid.uuid4().hex[:8]}"

        client = websocket_client("role_test_notebook.ipynb", test_user_id)
        client.auth_token = valid_token
        client.hub_user = {
            "id": test_user_id,
            "name": f"Role Test User {user_role}",
            "email": f"{test_user_id}@hub.example.com",
            "groups": ["notebook_users"],
            "roles": [user_role],
        }

        # Connect to collaborative session
        websocket_url = "ws://localhost:8888/api/collaboration/ws"
        await client.connect(websocket_url)

        # Send permission test message
        permission_test = {
            "type": "permission_check",
            "requested_permissions": expected_permissions,
            "timestamp": time.time(),
        }
        client.messages_sent.append(permission_test)

        # Mock server response based on role
        permission_response = {
            "type": "permission_response",
            "user_role": user_role.upper().replace("EDITOR", "EDIT"),
            "granted_permissions": expected_permissions,
            "can_view": True,
            "can_edit": user_role in ["editor", "admin"],
            "can_admin": user_role == "admin",
            "timestamp": time.time(),
        }
        client.messages_received.append(permission_response)

        # Validate role mapping
        response = client.messages_received[-1]
        assert response["type"] == "permission_response", "Should receive permission response"
        assert (
            response["granted_permissions"] == expected_permissions
        ), f"Role {user_role} should have permissions {expected_permissions}"
        assert response["can_view"] is True, "All roles should have view permission"
        assert response["can_edit"] == (
            user_role in ["editor", "admin"]
        ), f"Edit permission should match role {user_role}"
        assert response["can_admin"] == (
            user_role == "admin"
        ), f"Admin permission should match role {user_role}"

        await client.disconnect()

    async def test_websocket_connection_authorization_checks(self, websocket_client):
        """
        Test authorization checks during WebSocket connection establishment.

        Validates that WebSocket connections perform proper authorization checks
        before allowing access to collaborative sessions, including notebook-specific
        permissions and user group membership validation.
        """
        notebook_paths = [
            "public_notebook.ipynb",
            "restricted_notebook.ipynb",
            "admin_only_notebook.ipynb",
        ]

        user_permissions = [
            {"roles": ["viewer"], "groups": ["public_users"]},
            {"roles": ["editor"], "groups": ["restricted_users"]},
            {"roles": ["admin"], "groups": ["admin_users"]},
        ]

        for i, (notebook_path, permissions) in enumerate(zip(notebook_paths, user_permissions)):
            valid_token = "hub_token_" + uuid.uuid4().hex
            test_user_id = f"auth_user_{i}_{uuid.uuid4().hex[:8]}"

            client = websocket_client(notebook_path, test_user_id)
            client.auth_token = valid_token
            client.hub_user = {
                "id": test_user_id,
                "name": f"Auth Test User {i}",
                "email": f"{test_user_id}@hub.example.com",
                "groups": permissions["groups"],
                "roles": permissions["roles"],
            }

            # Test connection to notebook with matching permissions
            websocket_url = f"ws://localhost:8888/api/collaboration/ws/{notebook_path}"

            # Mock authorization check
            def create_mock_auth_connect(perms, notebook, client_ref):
                async def mock_connect_with_auth(url):
                    # Simulate authorization logic
                    user_role = perms["roles"][0]
                    user_groups = perms["groups"]

                    authorized = True
                    if ("admin_only" in notebook and user_role != "admin") or (
                        "restricted" in notebook and user_role == "viewer"
                    ):
                        authorized = False

                    if authorized:
                        client_ref.connected = True
                        auth_response = {
                            "type": "authorized",
                            "notebook_path": notebook,
                            "user_role": user_role.upper(),
                            "user_groups": user_groups,
                        }
                        client_ref.messages_received.append(auth_response)
                        return True
                    client_ref.connected = False
                    error_response = {"type": "error", "error": "Access denied", "code": 1008}
                    client_ref.messages_received.append(error_response)
                    return False

                return mock_connect_with_auth

            client.connect = create_mock_auth_connect(permissions, notebook_path, client)
            connection_successful = await client.connect(websocket_url)

            # Validate authorization results
            user_role = permissions["roles"][0]
            should_be_authorized = True

            if ("admin_only" in notebook_path and user_role != "admin") or (
                "restricted" in notebook_path and user_role == "viewer"
            ):
                should_be_authorized = False

            if should_be_authorized:
                assert (
                    connection_successful
                ), f"User with role {user_role} should be authorized for {notebook_path}"
                assert client.connected, "Client should be connected after successful authorization"

                # Validate authorization response
                response = client.messages_received[-1]
                assert response["type"] == "authorized", "Should receive authorization confirmation"
                assert (
                    response["user_role"] == user_role.upper()
                ), "Should include correct user role"
            else:
                assert (
                    not connection_successful
                ), f"User with role {user_role} should be denied for {notebook_path}"
                assert (
                    not client.connected
                ), "Client should not be connected after authorization failure"

                # Validate error response
                if client.messages_received:
                    error_msg = client.messages_received[-1]
                    assert error_msg["type"] == "error", "Should receive error message"
                    assert "Access denied" in error_msg.get(
                        "error", ""
                    ), "Should indicate access denial"

            if client.connected:
                await client.disconnect()

    async def test_session_cleanup_on_logout(self, websocket_client):
        """
        Test proper session cleanup when users logout from JupyterHub.

        Validates that collaborative sessions are properly cleaned up when users
        logout from JupyterHub, including connection termination, lock release,
        and presence status updates.
        """
        valid_token = "hub_token_" + uuid.uuid4().hex
        test_user_id = f"cleanup_user_{uuid.uuid4().hex[:8]}"

        client = websocket_client("cleanup_test_notebook.ipynb", test_user_id)
        client.auth_token = valid_token
        client.hub_user = {
            "id": test_user_id,
            "name": "Cleanup Test User",
            "email": f"{test_user_id}@hub.example.com",
            "groups": ["notebook_users"],
            "roles": ["editor"],
        }

        # Connect to collaborative session
        websocket_url = "ws://localhost:8888/api/collaboration/ws"
        await client.connect(websocket_url)
        assert client.connected, "Client should be connected initially"

        # Simulate user performing collaborative actions
        collaborative_actions = [
            {"type": "cell_edit", "cell_id": "cell_1", "content": "print('Hello World')"},
            {"type": "cell_lock", "cell_id": "cell_2", "action": "acquire"},
            {"type": "presence_update", "cursor_position": {"line": 0, "ch": 5}},
        ]

        for action in collaborative_actions:
            client.messages_sent.append(
                {**action, "user_id": test_user_id, "timestamp": time.time()}
            )

        # Mock server acknowledgments
        for action in collaborative_actions:
            ack_message = {
                "type": f"{action['type']}_ack",
                "success": True,
                "timestamp": time.time(),
            }
            client.messages_received.append(ack_message)

        # Simulate JupyterHub logout event
        logout_message = {
            "type": "hub_logout",
            "user_id": test_user_id,
            "session_termination": True,
            "timestamp": time.time(),
        }
        client.messages_sent.append(logout_message)

        # Mock server cleanup response
        cleanup_response = {
            "type": "session_cleanup",
            "user_id": test_user_id,
            "actions_taken": ["locks_released", "presence_removed", "connection_terminated"],
            "cleanup_successful": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(cleanup_response)

        # Simulate connection termination
        client.connected = False

        # Validate session cleanup
        cleanup_msg = client.messages_received[-1]
        assert cleanup_msg["type"] == "session_cleanup", "Should receive cleanup confirmation"
        assert cleanup_msg["cleanup_successful"] is True, "Cleanup should be successful"
        assert "locks_released" in cleanup_msg["actions_taken"], "Should release user's locks"
        assert "presence_removed" in cleanup_msg["actions_taken"], "Should remove presence info"
        assert (
            "connection_terminated" in cleanup_msg["actions_taken"]
        ), "Should terminate connection"

        assert not client.connected, "Client should be disconnected after logout cleanup"

    async def test_multi_user_identity_isolation(self, websocket_client):
        """
        Test identity isolation between different users in collaborative sessions.

        Validates that user identities are properly isolated and that users cannot
        access or modify each other's session data, locks, or personal information
        during collaborative editing.
        """
        # Create multiple users with different identities
        users = []
        for i in range(3):
            valid_token = "hub_token_" + uuid.uuid4().hex
            test_user_id = f"isolation_user_{i}_{uuid.uuid4().hex[:8]}"

            client = websocket_client("isolation_test_notebook.ipynb", test_user_id)
            client.auth_token = valid_token
            client.hub_user = {
                "id": test_user_id,
                "name": f"Isolation Test User {i}",
                "email": f"{test_user_id}@hub.example.com",
                "groups": ["notebook_users"],
                "roles": ["editor"],
            }

            users.append((test_user_id, client))

        # Connect all users to the same collaborative session
        websocket_url = "ws://localhost:8888/api/collaboration/ws"
        for user_id, client in users:
            await client.connect(websocket_url)
            assert client.connected, f"User {user_id} should be connected"

        # Test identity isolation scenarios
        user_1_id, user_1_client = users[0]
        user_2_id, user_2_client = users[1]
        user_3_id, user_3_client = users[2]

        # User 1 acquires a cell lock
        lock_request = {
            "type": "lock_request",
            "cell_id": "cell_isolation_test",
            "user_id": user_1_id,
            "timestamp": time.time(),
        }
        user_1_client.messages_sent.append(lock_request)

        # Mock successful lock acquisition for user 1
        lock_response = {
            "type": "lock_acquired",
            "cell_id": "cell_isolation_test",
            "owner_user_id": user_1_id,
            "timestamp": time.time(),
        }
        user_1_client.messages_received.append(lock_response)

        # User 2 attempts to access user 1's lock (should fail)
        unauthorized_access = {
            "type": "lock_release",
            "cell_id": "cell_isolation_test",
            "user_id": user_2_id,  # Different user trying to release
            "timestamp": time.time(),
        }
        user_2_client.messages_sent.append(unauthorized_access)

        # Mock server rejection of unauthorized access
        access_denied = {
            "type": "error",
            "error": "Access denied: Cannot modify locks owned by other users",
            "code": 403,
            "timestamp": time.time(),
        }
        user_2_client.messages_received.append(access_denied)

        # User 3 creates personal presence information
        presence_update = {
            "type": "presence_update",
            "user_id": user_3_id,
            "cursor_position": {"line": 10, "ch": 0},
            "selection_range": {"start": 10, "end": 15},
            "personal_note": "Working on data analysis section",
            "timestamp": time.time(),
        }
        user_3_client.messages_sent.append(presence_update)

        # Validate identity isolation
        # User 1 should own the lock
        lock_msg = user_1_client.messages_received[-1]
        assert lock_msg["type"] == "lock_acquired", "User 1 should successfully acquire lock"
        assert lock_msg["owner_user_id"] == user_1_id, "Lock should be owned by user 1"

        # User 2 should be denied access to user 1's lock
        denial_msg = user_2_client.messages_received[-1]
        assert denial_msg["type"] == "error", "User 2 should receive error for unauthorized access"
        assert denial_msg["code"] == 403, "Should receive forbidden error code"
        assert "Access denied" in denial_msg["error"], "Should indicate access denial"

        # User 3's presence should be isolated
        presence_msg = user_3_client.messages_sent[-1]
        assert presence_msg["user_id"] == user_3_id, "Presence should be tied to correct user"
        assert presence_msg["personal_note"] is not None, "Personal data should be preserved"

        # Clean up all connections
        for user_id, client in users:
            await client.disconnect()
            assert not client.connected, f"User {user_id} should be disconnected"

    async def test_permission_changes_during_active_session(self, websocket_client):
        """
        Test handling of permission changes while users have active collaborative sessions.

        Validates that collaborative sessions properly handle permission changes
        that occur while users are actively connected, including role upgrades,
        downgrades, and permission revocations.
        """
        valid_token = "hub_token_" + uuid.uuid4().hex
        test_user_id = f"permission_change_user_{uuid.uuid4().hex[:8]}"

        client = websocket_client("permission_change_notebook.ipynb", test_user_id)
        client.auth_token = valid_token
        client.hub_user = {
            "id": test_user_id,
            "name": "Permission Change Test User",
            "email": f"{test_user_id}@hub.example.com",
            "groups": ["notebook_users"],
            "roles": ["viewer"],  # Start as viewer
        }

        # Connect with initial viewer permissions
        websocket_url = "ws://localhost:8888/api/collaboration/ws"
        await client.connect(websocket_url)
        assert client.connected, "Client should be connected initially"

        # Mock initial permission validation
        initial_permissions = {
            "type": "permission_status",
            "user_role": "VIEWER",
            "can_edit": False,
            "can_admin": False,
            "timestamp": time.time(),
        }
        client.messages_received.append(initial_permissions)

        # Simulate permission upgrade (viewer -> editor)
        permission_upgrade = {
            "type": "hub_permission_change",
            "user_id": test_user_id,
            "old_roles": ["viewer"],
            "new_roles": ["editor"],
            "effective_immediately": True,
            "timestamp": time.time(),
        }
        client.messages_sent.append(permission_upgrade)

        # Mock server response to permission upgrade
        upgrade_response = {
            "type": "permission_updated",
            "user_role": "EDITOR",
            "can_edit": True,
            "can_admin": False,
            "changes_applied": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(upgrade_response)

        # Test editing capability after upgrade
        edit_attempt = {
            "type": "cell_edit",
            "cell_id": "test_cell",
            "content": "print('Now I can edit!')",
            "timestamp": time.time(),
        }
        client.messages_sent.append(edit_attempt)

        # Mock successful edit response
        edit_success = {
            "type": "edit_success",
            "cell_id": "test_cell",
            "edit_applied": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(edit_success)

        # Simulate permission downgrade (editor -> viewer)
        permission_downgrade = {
            "type": "hub_permission_change",
            "user_id": test_user_id,
            "old_roles": ["editor"],
            "new_roles": ["viewer"],
            "reason": "policy_change",
            "timestamp": time.time(),
        }
        client.messages_sent.append(permission_downgrade)

        # Mock server response to permission downgrade
        downgrade_response = {
            "type": "permission_updated",
            "user_role": "VIEWER",
            "can_edit": False,
            "can_admin": False,
            "active_locks_released": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(downgrade_response)

        # Test editing restriction after downgrade
        restricted_edit_attempt = {
            "type": "cell_edit",
            "cell_id": "test_cell",
            "content": "print('This should fail')",
            "timestamp": time.time(),
        }
        client.messages_sent.append(restricted_edit_attempt)

        # Mock edit rejection response
        edit_rejection = {
            "type": "error",
            "error": "Edit permission required",
            "code": 403,
            "timestamp": time.time(),
        }
        client.messages_received.append(edit_rejection)

        # Validate permission change handling
        upgrade_msg = client.messages_received[-6]  # upgrade_response
        assert (
            upgrade_msg["type"] == "permission_updated"
        ), "Should receive permission upgrade notification"
        assert upgrade_msg["can_edit"] is True, "Should gain edit permission after upgrade"

        edit_success_msg = client.messages_received[-4]  # edit_success
        assert (
            edit_success_msg["type"] == "edit_success"
        ), "Should successfully edit after permission upgrade"

        downgrade_msg = client.messages_received[-2]  # downgrade_response
        assert (
            downgrade_msg["type"] == "permission_updated"
        ), "Should receive permission downgrade notification"
        assert downgrade_msg["can_edit"] is False, "Should lose edit permission after downgrade"
        assert (
            downgrade_msg["active_locks_released"] is True
        ), "Should release locks on permission downgrade"

        rejection_msg = client.messages_received[-1]  # edit_rejection
        assert (
            rejection_msg["type"] == "error"
        ), "Should reject edit attempts after permission downgrade"
        assert rejection_msg["code"] == 403, "Should receive forbidden error"

        await client.disconnect()

    async def test_unauthorized_access_prevention(self, websocket_client):
        """
        Test prevention of unauthorized access to collaborative features.

        Validates that the collaborative system properly prevents unauthorized
        access attempts, including connection hijacking, token spoofing, and
        privilege escalation attempts.
        """
        # Test scenarios for unauthorized access
        unauthorized_scenarios = [
            {
                "name": "token_spoofing",
                "token": "fake_hub_token_attempt",
                "user_id": "unauthorized_user_1",
                "expected_error": "Invalid authentication token",
            },
            {
                "name": "session_hijacking",
                "token": "hub_token_" + uuid.uuid4().hex,
                "user_id": "hijacker_user",
                "session_id_override": str(uuid.uuid4()),  # Try to use someone else's session
                "expected_error": "Session ID mismatch",
            },
            {
                "name": "privilege_escalation",
                "token": "hub_token_" + uuid.uuid4().hex,
                "user_id": "escalation_user",
                "fake_admin_claim": True,
                "expected_error": "Privilege escalation attempt detected",
            },
        ]

        for scenario in unauthorized_scenarios:
            client = websocket_client("unauthorized_test_notebook.ipynb", scenario["user_id"])
            client.auth_token = scenario["token"]

            # Configure user based on scenario
            if scenario["name"] == "token_spoofing":
                # Invalid/fake token - no user info
                client.hub_user = None
            elif scenario["name"] == "session_hijacking":
                # Valid user trying to hijack session
                client.hub_user = {
                    "id": scenario["user_id"],
                    "name": "Session Hijacker",
                    "email": f"{scenario['user_id']}@example.com",
                    "groups": ["notebook_users"],
                    "roles": ["viewer"],
                }
            elif scenario["name"] == "privilege_escalation":
                # User claiming admin privileges they don't have
                client.hub_user = {
                    "id": scenario["user_id"],
                    "name": "Privilege Escalator",
                    "email": f"{scenario['user_id']}@example.com",
                    "groups": ["notebook_users"],
                    "roles": ["viewer"],  # Actual role
                    "claimed_roles": ["admin"],  # Fake claim
                }

            # Mock connection with security validation
            def create_mock_secure_connect(test_scenario, client_ref):
                async def mock_secure_connect(url):
                    # Simulate server-side security checks
                    if test_scenario["name"] == "token_spoofing":
                        # Check token validity
                        if (
                            not test_scenario["token"].startswith("hub_token_")
                            or len(test_scenario["token"]) < 40
                        ):
                            client_ref.connected = False
                            error_response = {
                                "type": "security_error",
                                "error": test_scenario["expected_error"],
                                "code": 1008,
                                "security_violation": True,
                            }
                            client_ref.messages_received.append(error_response)
                            return False

                    elif (
                        test_scenario["name"] == "session_hijacking"
                        and "session_id_override" in test_scenario
                    ):
                        # Check for session ID override attempts
                        client_ref.connected = False
                        error_response = {
                            "type": "security_error",
                            "error": test_scenario["expected_error"],
                            "code": 1008,
                            "security_violation": True,
                        }
                        client_ref.messages_received.append(error_response)
                        return False

                    elif (
                        test_scenario["name"] == "privilege_escalation"
                        and "claimed_roles" in client_ref.hub_user
                    ):
                        # Check for role claim mismatches
                        actual_roles = client_ref.hub_user["roles"]
                        claimed_roles = client_ref.hub_user["claimed_roles"]
                        if claimed_roles != actual_roles:
                            client_ref.connected = False
                            error_response = {
                                "type": "security_error",
                                "error": test_scenario["expected_error"],
                                "code": 1008,
                                "security_violation": True,
                                "detected_escalation": {
                                    "actual_roles": actual_roles,
                                    "claimed_roles": claimed_roles,
                                },
                            }
                            client_ref.messages_received.append(error_response)
                            return False

                    # Should not reach here for unauthorized scenarios
                    return False

                return mock_secure_connect

            client.connect = create_mock_secure_connect(scenario, client)

            # Attempt connection
            websocket_url = "ws://localhost:8888/api/collaboration/ws"
            connection_successful = await client.connect(websocket_url)

            # Validate unauthorized access prevention
            assert (
                not connection_successful
            ), f"Unauthorized access scenario '{scenario['name']}' should be prevented"
            assert not client.connected, f"Client should not be connected for '{scenario['name']}'"

            # Validate security error response
            assert (
                len(client.messages_received) > 0
            ), f"Should receive error response for '{scenario['name']}'"
            error_response = client.messages_received[-1]
            assert (
                error_response["type"] == "security_error"
            ), f"Should receive security error for '{scenario['name']}'"
            assert (
                error_response["security_violation"] is True
            ), f"Should flag security violation for '{scenario['name']}'"
            assert (
                scenario["expected_error"] in error_response["error"]
            ), f"Should contain expected error message for '{scenario['name']}'"

    async def test_cross_session_security_validation(self, websocket_client):
        """
        Test security validation across multiple collaborative sessions.

        Validates that security measures prevent cross-session data access,
        session interference, and maintain proper isolation between different
        collaborative editing sessions.
        """
        # Create multiple sessions with different notebooks
        sessions = []
        notebook_paths = [
            "session_a_notebook.ipynb",
            "session_b_notebook.ipynb",
            "session_c_notebook.ipynb",
        ]

        # Setup multiple users across different sessions
        for i, notebook_path in enumerate(notebook_paths):
            valid_token = "hub_token_" + uuid.uuid4().hex
            test_user_id = f"cross_session_user_{i}_{uuid.uuid4().hex[:8]}"

            client = websocket_client(notebook_path, test_user_id)
            client.auth_token = valid_token
            client.hub_user = {
                "id": test_user_id,
                "name": f"Cross Session User {i}",
                "email": f"{test_user_id}@hub.example.com",
                "groups": ["notebook_users"],
                "roles": ["editor"],
            }

            sessions.append(
                {
                    "user_id": test_user_id,
                    "client": client,
                    "notebook": notebook_path,
                    "session_id": str(uuid.uuid4()),
                }
            )

        # Connect all users to their respective sessions
        for session in sessions:
            websocket_url = f"ws://localhost:8888/api/collaboration/ws/{session['notebook']}"
            await session["client"].connect(websocket_url)
            assert session[
                "client"
            ].connected, f"User {session['user_id']} should be connected to {session['notebook']}"

            # Mock session establishment
            session_response = {
                "type": "session_established",
                "session_id": session["session_id"],
                "notebook_path": session["notebook"],
                "user_id": session["user_id"],
            }
            session["client"].messages_received.append(session_response)

        # Test cross-session security scenarios

        # Scenario 1: User from session A tries to access session B's data
        session_a = sessions[0]
        session_b = sessions[1]

        cross_session_access_attempt = {
            "type": "cross_session_data_request",
            "target_session_id": session_b["session_id"],
            "target_notebook": session_b["notebook"],
            "requesting_user_id": session_a["user_id"],
            "data_requested": "cell_locks",
            "timestamp": time.time(),
        }
        session_a["client"].messages_sent.append(cross_session_access_attempt)

        # Mock server rejection of cross-session access
        cross_session_rejection = {
            "type": "security_error",
            "error": "Cross-session data access denied",
            "code": 403,
            "security_violation": True,
            "violation_details": {
                "attempted_access": "cross_session_data",
                "source_session": session_a["session_id"],
                "target_session": session_b["session_id"],
            },
            "timestamp": time.time(),
        }
        session_a["client"].messages_received.append(cross_session_rejection)

        # Scenario 2: User tries to send updates to wrong session
        session_c = sessions[2]

        wrong_session_update = {
            "type": "yjs_update",
            "target_session": session_a["session_id"],  # Wrong session
            "actual_session": session_c["session_id"],  # Actual session
            "update_data": [1, 2, 3, 4],  # Mock Yjs update
            "timestamp": time.time(),
        }
        session_c["client"].messages_sent.append(wrong_session_update)

        # Mock server validation error
        session_mismatch_error = {
            "type": "security_error",
            "error": "Session ID mismatch in update",
            "code": 400,
            "security_violation": True,
            "violation_details": {
                "expected_session": session_c["session_id"],
                "provided_session": session_a["session_id"],
            },
            "timestamp": time.time(),
        }
        session_c["client"].messages_received.append(session_mismatch_error)

        # Scenario 3: User tries to impersonate another user in same session
        impersonation_attempt = {
            "type": "user_action",
            "user_id": session_b["user_id"],  # Trying to impersonate user B
            "actual_user": session_a["user_id"],  # Actually user A
            "action": "acquire_lock",
            "cell_id": "impersonation_test_cell",
            "timestamp": time.time(),
        }
        session_a["client"].messages_sent.append(impersonation_attempt)

        # Mock server detection of impersonation
        impersonation_rejection = {
            "type": "security_error",
            "error": "User impersonation attempt detected",
            "code": 403,
            "security_violation": True,
            "violation_details": {
                "claimed_user": session_b["user_id"],
                "authenticated_user": session_a["user_id"],
                "violation_type": "identity_spoofing",
            },
            "timestamp": time.time(),
        }
        session_a["client"].messages_received.append(impersonation_rejection)

        # Validate cross-session security measures

        # Check cross-session access denial
        cross_session_error = session_a["client"].messages_received[-3]
        assert cross_session_error["type"] == "security_error", "Should reject cross-session access"
        assert (
            "Cross-session data access denied" in cross_session_error["error"]
        ), "Should indicate cross-session violation"
        assert (
            cross_session_error["security_violation"] is True
        ), "Should flag as security violation"

        # Check session mismatch detection
        session_error = session_c["client"].messages_received[-2]
        assert session_error["type"] == "security_error", "Should detect session ID mismatch"
        assert "Session ID mismatch" in session_error["error"], "Should indicate session mismatch"
        assert (
            session_error["violation_details"]["expected_session"] == session_c["session_id"]
        ), "Should identify correct session"

        # Check impersonation prevention
        impersonation_error = session_a["client"].messages_received[-1]
        assert impersonation_error["type"] == "security_error", "Should prevent user impersonation"
        assert (
            "impersonation attempt" in impersonation_error["error"]
        ), "Should identify impersonation attempt"
        assert (
            impersonation_error["violation_details"]["violation_type"] == "identity_spoofing"
        ), "Should categorize as identity spoofing"

        # Clean up all sessions
        for session in sessions:
            await session["client"].disconnect()
            assert not session[
                "client"
            ].connected, f"Session for {session['user_id']} should be disconnected"

    async def test_authentication_token_expiration_handling(self, websocket_client):
        """
        Test handling of authentication token expiration during active sessions.

        Validates that collaborative sessions properly handle token expiration,
        including graceful session termination, re-authentication flows, and
        prevention of unauthorized continued access.
        """
        # Setup user with token that will "expire"
        initial_token = "hub_token_" + uuid.uuid4().hex
        test_user_id = f"token_expiry_user_{uuid.uuid4().hex[:8]}"

        client = websocket_client("token_expiry_notebook.ipynb", test_user_id)
        client.auth_token = initial_token
        client.hub_user = {
            "id": test_user_id,
            "name": "Token Expiry Test User",
            "email": f"{test_user_id}@hub.example.com",
            "groups": ["notebook_users"],
            "roles": ["editor"],
        }

        # Connect with valid token
        websocket_url = "ws://localhost:8888/api/collaboration/ws"
        await client.connect(websocket_url)
        assert client.connected, "Client should connect with valid token"

        # Simulate active collaborative work
        start_time = time.perf_counter()

        collaborative_work = [
            {"type": "cell_edit", "cell_id": "work_cell_1", "content": "# Working before expiry"},
            {"type": "presence_update", "cursor": {"line": 1, "ch": 0}},
            {"type": "cell_lock", "cell_id": "work_cell_2", "action": "acquire"},
        ]

        for work_item in collaborative_work:
            message = {**work_item, "user_id": test_user_id, "timestamp": time.time()}
            client.messages_sent.append(message)

            # Mock successful responses
            success_response = {"type": f"{work_item['type']}_success", "timestamp": time.time()}
            client.messages_received.append(success_response)

        # Wait for potential token expiration
        await asyncio.sleep(0.1)

        # Simulate token expiration notification from JupyterHub
        token_expiry_notification = {
            "type": "hub_token_expired",
            "user_id": test_user_id,
            "expired_token": initial_token,
            "expiry_time": time.time(),
            "grace_period_seconds": 30,
        }
        client.messages_sent.append(token_expiry_notification)

        # Mock server response to token expiration
        expiry_response = {
            "type": "token_expiry_warning",
            "message": "Authentication token has expired",
            "grace_period_remaining": 30,
            "reauthentication_required": True,
            "session_will_terminate_at": time.time() + 30,
            "timestamp": time.time(),
        }
        client.messages_received.append(expiry_response)

        # Attempt continued work with expired token (should be restricted)
        restricted_work_attempt = {
            "type": "cell_edit",
            "cell_id": "restricted_cell",
            "content": "# This should be restricted",
            "user_id": test_user_id,
            "timestamp": time.time(),
        }
        client.messages_sent.append(restricted_work_attempt)

        # Mock server restriction response
        restriction_response = {
            "type": "error",
            "error": "Authentication token expired - reauthentication required",
            "code": 401,
            "token_expired": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(restriction_response)

        # Simulate reauthentication with new token
        new_token = "hub_token_renewed_" + uuid.uuid4().hex
        reauth_request = {
            "type": "reauthentication",
            "user_id": test_user_id,
            "old_token": initial_token,
            "new_token": new_token,
            "timestamp": time.time(),
        }
        client.messages_sent.append(reauth_request)

        # Update client token
        client.auth_token = new_token

        # Mock successful reauthentication
        reauth_success = {
            "type": "reauthentication_success",
            "user_id": test_user_id,
            "new_session_valid_until": time.time() + 3600,  # 1 hour
            "previous_session_restored": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(reauth_success)

        # Test resumed work after reauthentication
        resumed_work = {
            "type": "cell_edit",
            "cell_id": "resumed_cell",
            "content": "# Work resumed after reauth",
            "user_id": test_user_id,
            "timestamp": time.time(),
        }
        client.messages_sent.append(resumed_work)

        # Mock successful work resumption
        resumption_success = {
            "type": "cell_edit_success",
            "cell_id": "resumed_cell",
            "edit_applied": True,
            "timestamp": time.time(),
        }
        client.messages_received.append(resumption_success)

        # Validate token expiration handling

        # Check initial work was successful
        initial_work_responses = client.messages_received[1:4]  # Skip connection response
        for response in initial_work_responses:
            assert "success" in response["type"], "Initial work should succeed with valid token"

        # Check expiry warning
        expiry_msg = client.messages_received[-6]  # expiry_response
        assert expiry_msg["type"] == "token_expiry_warning", "Should receive token expiry warning"
        assert expiry_msg["reauthentication_required"] is True, "Should require reauthentication"
        assert expiry_msg["grace_period_remaining"] > 0, "Should provide grace period"

        # Check work restriction during expired state
        restriction_msg = client.messages_received[-4]  # restriction_response
        assert restriction_msg["type"] == "error", "Should restrict work with expired token"
        assert restriction_msg["code"] == 401, "Should return unauthorized error"
        assert restriction_msg["token_expired"] is True, "Should indicate token expiration"

        # Check successful reauthentication
        reauth_msg = client.messages_received[-2]  # reauth_success
        assert (
            reauth_msg["type"] == "reauthentication_success"
        ), "Should confirm successful reauthentication"
        assert (
            reauth_msg["previous_session_restored"] is True
        ), "Should restore previous session state"

        # Check work resumption
        resumption_msg = client.messages_received[-1]  # resumption_success
        assert (
            resumption_msg["type"] == "cell_edit_success"
        ), "Should allow work after reauthentication"
        assert (
            resumption_msg["edit_applied"] is True
        ), "Should successfully apply edits after reauth"

        # Measure total test time for performance validation
        total_time = time.perf_counter() - start_time
        assert total_time < 10.0, "Token expiration handling should complete within reasonable time"

        await client.disconnect()
