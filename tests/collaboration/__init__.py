"""
Collaboration test suite package for Jupyter Notebook v7.

This package contains comprehensive tests for the real-time collaborative editing
capabilities implemented in Jupyter Notebook v7, including:

- Real-Time Document Synchronization (F-024)
- User Presence & Awareness (F-025)
- Cell-Level Locking (F-026)
- Change History & Versioning (F-027)
- Permissions & Access Control (F-028)
- Comment & Review System (F-029)

The test suite validates multi-user scenarios, performance requirements,
WebSocket communication, CRDT synchronization, and UI interactions across
the collaborative editing infrastructure.

Test Organization:
- test_yjs_handler.py: WebSocket handler and server-side synchronization
- test_awareness.py: User presence and awareness system
- test_locks.py: Cell-level locking mechanisms
- test_history.py: Change history and versioning
- test_permissions.py: Role-based access control
- test_comments.py: Comment and review system

Performance Requirements Validated:
- Collaborative edit latency <100ms (95th percentile)
- Memory overhead <20% increase from baseline
- Support for 10+ concurrent users without degradation
- WebSocket message delivery 99.9% success rate

The test suite uses pytest for Python components, Jest for TypeScript components,
and Playwright for multi-user end-to-end scenarios with specialized infrastructure
for WebSocket simulation and concurrent browser context management.
"""

# This file intentionally left minimal to serve as a standard Python package
# initialization file. Specific test utilities and fixtures are defined in
# individual test modules and conftest.py files.
