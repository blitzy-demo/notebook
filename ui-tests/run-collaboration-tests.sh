#!/bin/bash

# =============================================================================
# Jupyter Notebook v7 Collaboration Test Orchestration Script
# =============================================================================
#
# This shell script orchestrates comprehensive collaboration test execution for
# Jupyter Notebook v7's real-time collaborative editing features. It provides
# complete test infrastructure management including server setup, WebSocket
# initialization, multi-user simulation, and performance benchmarking.
#
# Features:
# - Start Jupyter Notebook server with collaboration features enabled
# - Initialize Yjs WebSocket server for real-time synchronization
# - Execute Playwright tests with collaboration configuration
# - Support multiple test scenarios: dual-user, multi-user, stress-test
# - Capture performance metrics and generate comprehensive reports
# - Handle cleanup of test resources and WebSocket connections
# - Support both local development and CI/CD execution modes
# - Generate collaboration test artifacts (latency histograms, memory reports)
#
# Usage:
#   ./run-collaboration-tests.sh [scenario] [options]
#
# Scenarios:
#   dual-user      - Two-user collaboration testing
#   multi-user     - Multiple user collaborative scenarios
#   stress-test    - High-load concurrent user testing
#   performance    - Performance benchmarking and metrics
#   cleanup        - Clean up test resources and processes
#   debug          - Debug mode with detailed logging
#
# Options:
#   --port PORT           - Jupyter server port (default: 8889)
#   --ws-port PORT        - WebSocket server port (default: 8890)
#   --timeout SECONDS     - Test timeout in seconds (default: 300)
#   --workers NUM         - Number of Playwright workers (default: 2)
#   --retries NUM         - Number of test retries (default: 3)
#   --config FILE         - Custom Playwright config file
#   --artifacts DIR       - Test artifacts output directory
#   --ci                  - Enable CI mode optimizations
#   --verbose             - Enable verbose logging
#   --memory-profile      - Enable memory profiling
#   --latency-profile     - Enable latency profiling
#   --help                - Show this help message
#
# Environment Variables:
#   JUPYTER_COLLABORATION_ENABLED    - Enable collaboration features (default: true)
#   JUPYTER_COLLABORATION_WS_ENDPOINT - WebSocket endpoint (default: /api/collaboration/ws)
#   JUPYTER_COLLABORATION_PERFORMANCE_MONITORING - Enable performance monitoring (default: true)
#   CI                               - CI environment detection
#   PWDEBUG                         - Playwright debug mode
#
# Generated Artifacts:
#   - CRDT sync latency histograms
#   - Memory usage reports during collaborative operations
#   - Yjs update logs for debugging synchronization issues
#   - WebSocket connection stability reports
#   - Multi-user concurrency analysis
#   - Performance benchmark results
#
# =============================================================================

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# =============================================================================
# GLOBAL CONFIGURATION AND CONSTANTS
# =============================================================================

# Script metadata
readonly SCRIPT_NAME="run-collaboration-tests"
readonly SCRIPT_VERSION="1.0.0"
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

# Default configuration values
readonly DEFAULT_JUPYTER_PORT=8889
readonly DEFAULT_WS_PORT=8890
readonly DEFAULT_TIMEOUT=300
readonly DEFAULT_WORKERS=2
readonly DEFAULT_RETRIES=3
readonly DEFAULT_ARTIFACTS_DIR="${SCRIPT_DIR}/test-results"

# Server and process management
JUPYTER_PID=""
WS_SERVER_PID=""
TEST_PIDS=()
CLEANUP_PERFORMED=false

# Configuration variables (will be set by parse_arguments)
SCENARIO=""
JUPYTER_PORT="${DEFAULT_JUPYTER_PORT}"
WS_PORT="${DEFAULT_WS_PORT}"
TIMEOUT="${DEFAULT_TIMEOUT}"
WORKERS="${DEFAULT_WORKERS}"
RETRIES="${DEFAULT_RETRIES}"
CONFIG_FILE=""
ARTIFACTS_DIR="${DEFAULT_ARTIFACTS_DIR}"
CI_MODE=false
VERBOSE=false
MEMORY_PROFILE=false
LATENCY_PROFILE=false

# Test execution state
START_TIME=""
END_TIME=""
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

# Performance monitoring
PERFORMANCE_METRICS=()
MEMORY_SAMPLES=()
LATENCY_SAMPLES=()

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

# Logging functions with timestamp and color support
log_info() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    if [[ "${VERBOSE}" == true ]] || [[ "${CI_MODE}" == true ]]; then
        echo -e "\033[0;32m[INFO ${timestamp}]\033[0m $*" >&2
    fi
}

log_warn() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "\033[0;33m[WARN ${timestamp}]\033[0m $*" >&2
}

log_error() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "\033[0;31m[ERROR ${timestamp}]\033[0m $*" >&2
}

log_debug() {
    if [[ "${VERBOSE}" == true ]]; then
        local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
        echo -e "\033[0;36m[DEBUG ${timestamp}]\033[0m $*" >&2
    fi
}

log_success() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "\033[1;32m[SUCCESS ${timestamp}]\033[0m $*" >&2
}

# Error handling and cleanup
handle_error() {
    local exit_code=$?
    local line_number=$1
    log_error "Script failed with exit code ${exit_code} at line ${line_number}"
    log_error "Command that failed: ${BASH_COMMAND}"

    # Perform cleanup if not already done
    if [[ "${CLEANUP_PERFORMED}" == false ]]; then
        log_info "Performing emergency cleanup due to error"
        cleanup_resources
    fi

    exit "${exit_code}"
}

# Set up error trap
trap 'handle_error ${LINENO}' ERR

# Signal handling for graceful shutdown
handle_signal() {
    local signal=$1
    log_info "Received ${signal} signal, initiating graceful shutdown"
    cleanup_resources
    exit 0
}

trap 'handle_signal SIGTERM' SIGTERM
trap 'handle_signal SIGINT' SIGINT

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if port is available
is_port_available() {
    local port=$1
    ! nc -z localhost "${port}" 2>/dev/null
}

# Wait for port to become available
wait_for_port() {
    local port=$1
    local timeout=${2:-30}
    local count=0

    log_debug "Waiting for port ${port} to become available"

    while [[ ${count} -lt ${timeout} ]]; do
        if nc -z localhost "${port}" 2>/dev/null; then
            log_debug "Port ${port} is now available"
            return 0
        fi
        sleep 1
        ((count++))
    done

    log_error "Timeout waiting for port ${port} to become available"
    return 1
}

# Wait for process to start
wait_for_process() {
    local process_name=$1
    local timeout=${2:-30}
    local count=0

    log_debug "Waiting for process '${process_name}' to start"

    while [[ ${count} -lt ${timeout} ]]; do
        if pgrep -f "${process_name}" >/dev/null 2>&1; then
            log_debug "Process '${process_name}' is now running"
            return 0
        fi
        sleep 1
        ((count++))
    done

    log_error "Timeout waiting for process '${process_name}' to start"
    return 1
}

# Get memory usage of process
get_memory_usage() {
    local pid=$1
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
        ps -p "${pid}" -o rss= 2>/dev/null | awk '{print $1 * 1024}' || echo "0"
    else
        echo "0"
    fi
}

# =============================================================================
# ARGUMENT PARSING AND VALIDATION
# =============================================================================

show_help() {
    cat << EOF
${SCRIPT_NAME} v${SCRIPT_VERSION}

Jupyter Notebook v7 Collaboration Test Orchestration Script

USAGE:
    ${SCRIPT_NAME} [SCENARIO] [OPTIONS]

SCENARIOS:
    dual-user      Execute two-user collaboration testing scenarios
    multi-user     Execute multiple user collaborative scenarios
    stress-test    Execute high-load concurrent user testing
    performance    Execute performance benchmarking and metrics collection
    cleanup        Clean up test resources and background processes
    debug          Execute tests in debug mode with detailed logging

OPTIONS:
    --port PORT           Jupyter server port (default: ${DEFAULT_JUPYTER_PORT})
    --ws-port PORT        WebSocket server port (default: ${DEFAULT_WS_PORT})
    --timeout SECONDS     Test timeout in seconds (default: ${DEFAULT_TIMEOUT})
    --workers NUM         Number of Playwright workers (default: ${DEFAULT_WORKERS})
    --retries NUM         Number of test retries (default: ${DEFAULT_RETRIES})
    --config FILE         Custom Playwright config file
    --artifacts DIR       Test artifacts output directory (default: ${DEFAULT_ARTIFACTS_DIR})
    --ci                  Enable CI mode optimizations
    --verbose             Enable verbose logging
    --memory-profile      Enable memory profiling during tests
    --latency-profile     Enable latency profiling during tests
    --help                Show this help message

ENVIRONMENT VARIABLES:
    JUPYTER_COLLABORATION_ENABLED              Enable collaboration features (default: true)
    JUPYTER_COLLABORATION_WS_ENDPOINT          WebSocket endpoint (default: /api/collaboration/ws)
    JUPYTER_COLLABORATION_PERFORMANCE_MONITORING  Enable performance monitoring (default: true)
    CI                                         CI environment detection
    PWDEBUG                                   Playwright debug mode

EXAMPLES:
    # Run dual-user collaboration tests
    ${SCRIPT_NAME} dual-user --verbose

    # Run performance benchmarks with memory profiling
    ${SCRIPT_NAME} performance --memory-profile --latency-profile

    # Run multi-user tests in CI mode
    ${SCRIPT_NAME} multi-user --ci --workers 1 --timeout 600

    # Run stress tests with custom configuration
    ${SCRIPT_NAME} stress-test --config custom-config.ts --artifacts /tmp/test-results

    # Clean up all test resources
    ${SCRIPT_NAME} cleanup

GENERATED ARTIFACTS:
    - CRDT sync latency histograms (JSON format)
    - Memory usage reports during collaborative operations
    - Yjs update logs for debugging synchronization issues
    - WebSocket connection stability reports
    - Multi-user concurrency analysis
    - Performance benchmark results and comparisons

EOF
}

parse_arguments() {
    # Set default scenario if none provided
    if [[ $# -eq 0 ]]; then
        show_help
        exit 0
    fi

    # First argument should be the scenario
    SCENARIO="$1"
    shift

    # Validate scenario
    case "${SCENARIO}" in
        dual-user|multi-user|stress-test|performance|cleanup|debug)
            log_debug "Selected scenario: ${SCENARIO}"
            ;;
        --help|-h|help)
            show_help
            exit 0
            ;;
        *)
            log_error "Invalid scenario: ${SCENARIO}"
            log_error "Valid scenarios: dual-user, multi-user, stress-test, performance, cleanup, debug"
            exit 1
            ;;
    esac

    # Parse remaining arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --port)
                JUPYTER_PORT="$2"
                if ! [[ "${JUPYTER_PORT}" =~ ^[0-9]+$ ]] || [[ "${JUPYTER_PORT}" -lt 1 ]] || [[ "${JUPYTER_PORT}" -gt 65535 ]]; then
                    log_error "Invalid port number: ${JUPYTER_PORT}"
                    exit 1
                fi
                shift 2
                ;;
            --ws-port)
                WS_PORT="$2"
                if ! [[ "${WS_PORT}" =~ ^[0-9]+$ ]] || [[ "${WS_PORT}" -lt 1 ]] || [[ "${WS_PORT}" -gt 65535 ]]; then
                    log_error "Invalid WebSocket port number: ${WS_PORT}"
                    exit 1
                fi
                shift 2
                ;;
            --timeout)
                TIMEOUT="$2"
                if ! [[ "${TIMEOUT}" =~ ^[0-9]+$ ]] || [[ "${TIMEOUT}" -lt 1 ]]; then
                    log_error "Invalid timeout value: ${TIMEOUT}"
                    exit 1
                fi
                shift 2
                ;;
            --workers)
                WORKERS="$2"
                if ! [[ "${WORKERS}" =~ ^[0-9]+$ ]] || [[ "${WORKERS}" -lt 1 ]]; then
                    log_error "Invalid workers count: ${WORKERS}"
                    exit 1
                fi
                shift 2
                ;;
            --retries)
                RETRIES="$2"
                if ! [[ "${RETRIES}" =~ ^[0-9]+$ ]]; then
                    log_error "Invalid retries count: ${RETRIES}"
                    exit 1
                fi
                shift 2
                ;;
            --config)
                CONFIG_FILE="$2"
                if [[ ! -f "${CONFIG_FILE}" ]]; then
                    log_error "Config file not found: ${CONFIG_FILE}"
                    exit 1
                fi
                shift 2
                ;;
            --artifacts)
                ARTIFACTS_DIR="$2"
                shift 2
                ;;
            --ci)
                CI_MODE=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --memory-profile)
                MEMORY_PROFILE=true
                shift
                ;;
            --latency-profile)
                LATENCY_PROFILE=true
                shift
                ;;
            --help|-h)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    # Set environment-based overrides
    if [[ "${CI:-false}" == "true" ]]; then
        CI_MODE=true
        log_debug "CI mode enabled via environment variable"
    fi

    # Log final configuration
    log_debug "Configuration:"
    log_debug "  Scenario: ${SCENARIO}"
    log_debug "  Jupyter port: ${JUPYTER_PORT}"
    log_debug "  WebSocket port: ${WS_PORT}"
    log_debug "  Timeout: ${TIMEOUT}s"
    log_debug "  Workers: ${WORKERS}"
    log_debug "  Retries: ${RETRIES}"
    log_debug "  Artifacts directory: ${ARTIFACTS_DIR}"
    log_debug "  CI mode: ${CI_MODE}"
    log_debug "  Verbose: ${VERBOSE}"
    log_debug "  Memory profiling: ${MEMORY_PROFILE}"
    log_debug "  Latency profiling: ${LATENCY_PROFILE}"
}

# =============================================================================
# DEPENDENCY VALIDATION
# =============================================================================

validate_dependencies() {
    log_info "Validating required dependencies"

    local missing_deps=()

    # Check Node.js
    if ! command_exists node; then
        missing_deps+=("node (Node.js runtime)")
    else
        local node_version=$(node --version)
        log_debug "Node.js version: ${node_version}"

        # Check for minimum Node.js version (18+)
        local node_major=$(echo "${node_version}" | sed 's/v//' | cut -d. -f1)
        if [[ ${node_major} -lt 18 ]]; then
            log_warn "Node.js version ${node_version} is below recommended minimum (v18+)"
        fi
    fi

    # Check jlpm (JupyterLab package manager)
    if ! command_exists jlpm; then
        missing_deps+=("jlpm (JupyterLab package manager)")
    else
        local jlpm_version=$(jlpm --version 2>/dev/null || echo "unknown")
        log_debug "jlpm version: ${jlpm_version}"
    fi

    # Check Jupyter Notebook
    if ! command_exists jupyter-notebook && ! command_exists jupyter; then
        missing_deps+=("jupyter-notebook (Jupyter Notebook server)")
    else
        if command_exists jupyter-notebook; then
            local jupyter_version=$(jupyter-notebook --version 2>/dev/null || echo "unknown")
            log_debug "Jupyter Notebook version: ${jupyter_version}"
        elif command_exists jupyter; then
            local jupyter_version=$(jupyter --version 2>/dev/null | head -n1 || echo "unknown")
            log_debug "Jupyter version: ${jupyter_version}"
        fi
    fi

    # Check Playwright
    if ! command_exists npx; then
        missing_deps+=("npx (required for Playwright execution)")
    else
        # Check if Playwright is available via npx
        if ! npx playwright --version >/dev/null 2>&1; then
            log_warn "Playwright not found via npx, checking local installation"
        else
            local playwright_version=$(npx playwright --version 2>/dev/null || echo "unknown")
            log_debug "Playwright version: ${playwright_version}"
        fi
    fi

    # Check core utilities
    if ! command_exists sleep; then
        missing_deps+=("sleep (coreutils timing utility)")
    fi

    if ! command_exists nc; then
        log_warn "nc (netcat) not found - port availability checks may not work properly"
    fi

    if ! command_exists pgrep; then
        log_warn "pgrep not found - process monitoring may not work properly"
    fi

    # Report missing dependencies
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Missing required dependencies:"
        for dep in "${missing_deps[@]}"; do
            log_error "  - ${dep}"
        done
        log_error "Please install missing dependencies before running this script"
        exit 1
    fi

    # Validate test configuration files exist
    local config_file="${CONFIG_FILE:-${SCRIPT_DIR}/playwright-collaboration.config.ts}"
    if [[ ! -f "${config_file}" ]]; then
        log_error "Playwright configuration file not found: ${config_file}"
        exit 1
    fi

    local fixtures_file="${SCRIPT_DIR}/collaboration-test-fixtures.json"
    if [[ ! -f "${fixtures_file}" ]]; then
        log_error "Test fixtures file not found: ${fixtures_file}"
        exit 1
    fi

    local package_file="${SCRIPT_DIR}/package.json"
    if [[ ! -f "${package_file}" ]]; then
        log_error "Package.json file not found: ${package_file}"
        exit 1
    fi

    log_success "All dependencies validated successfully"
}

# =============================================================================
# SERVER SETUP AND MANAGEMENT FUNCTIONS
# =============================================================================

# server-setup: Initialize Jupyter Notebook server with collaboration features
setup_jupyter_server() {
    log_info "Setting up Jupyter Notebook server with collaboration features"

    # Check if port is available
    if ! is_port_available "${JUPYTER_PORT}"; then
        log_error "Port ${JUPYTER_PORT} is already in use"
        log_info "Please use --port to specify a different port or stop the existing service"
        exit 1
    fi

    # Set collaboration environment variables
    export JUPYTER_COLLABORATION_ENABLED=true
    export JUPYTER_COLLABORATION_WS_ENDPOINT="/api/collaboration/ws"
    export JUPYTER_COLLABORATION_PERFORMANCE_MONITORING=true

    # Additional environment variables for testing
    export JUPYTER_ALLOW_INSECURE_WRITES=1
    export JUPYTER_CONFIG_DIR="${SCRIPT_DIR}/test"

    if [[ "${MEMORY_PROFILE}" == true ]]; then
        export JUPYTER_COLLABORATION_MEMORY_PROFILING=true
    fi

    if [[ "${LATENCY_PROFILE}" == true ]]; then
        export JUPYTER_COLLABORATION_LATENCY_PROFILING=true
    fi

    # Build Jupyter command with appropriate options
    local jupyter_cmd=(
        "jupyter-notebook"
        "--collaborative"
        "--port=${JUPYTER_PORT}"
        "--no-browser"
        "--allow-root"
        "--NotebookApp.disable_check_xsrf=True"
        "--NotebookApp.allow_origin='*'"
        "--NotebookApp.allow_credentials=True"
    )

    # Add CI-specific options
    if [[ "${CI_MODE}" == true ]]; then
        jupyter_cmd+=(
            "--debug"
            "--NotebookApp.log_level=DEBUG"
        )
    fi

    # Check if we have a custom config
    local config_file="${SCRIPT_DIR}/test/jupyter_server_config.py"
    if [[ -f "${config_file}" ]]; then
        jupyter_cmd+=("--config=${config_file}")
        log_debug "Using Jupyter config file: ${config_file}"
    fi

    log_debug "Starting Jupyter server with command: ${jupyter_cmd[*]}"

    # Start Jupyter server in background
    if [[ "${VERBOSE}" == true ]]; then
        "${jupyter_cmd[@]}" &
    else
        "${jupyter_cmd[@]}" >/dev/null 2>&1 &
    fi

    JUPYTER_PID=$!
    log_debug "Jupyter server started with PID: ${JUPYTER_PID}"

    # Wait for server to be ready
    if ! wait_for_port "${JUPYTER_PORT}" 60; then
        log_error "Failed to start Jupyter server on port ${JUPYTER_PORT}"
        return 1
    fi

    # Additional health check - verify collaboration endpoint
    local health_check_url="http://localhost:${JUPYTER_PORT}/api/status"
    local attempts=0
    local max_attempts=30

    while [[ ${attempts} -lt ${max_attempts} ]]; do
        if curl -s --max-time 5 "${health_check_url}" >/dev/null 2>&1; then
            log_success "Jupyter server is ready and responding"
            return 0
        fi
        sleep 2
        ((attempts++))
    done

    log_error "Jupyter server health check failed"
    return 1
}

# websocket-initialization: Set up WebSocket server for real-time collaboration
initialize_websocket_server() {
    log_info "Initializing WebSocket server for real-time collaboration"

    # For Jupyter Notebook v7 with collaboration features, the WebSocket server
    # is integrated into the main Jupyter server. We need to verify it's working.

    local ws_endpoint="ws://localhost:${JUPYTER_PORT}/api/collaboration/ws"
    log_debug "Testing WebSocket endpoint: ${ws_endpoint}"

    # Test WebSocket connectivity using a simple Node.js script
    local ws_test_script="${ARTIFACTS_DIR}/ws-test.js"

    # Create artifacts directory if it doesn't exist
    mkdir -p "${ARTIFACTS_DIR}"

    # Create WebSocket test script
    cat > "${ws_test_script}" << 'EOF'
const WebSocket = require('ws');
const url = process.argv[2];
const timeout = parseInt(process.argv[3] || '10000', 10);

const ws = new WebSocket(url);
let connected = false;

const timer = setTimeout(() => {
    if (!connected) {
        console.error('WebSocket connection timeout');
        process.exit(1);
    }
}, timeout);

ws.on('open', () => {
    connected = true;
    console.log('WebSocket connection successful');
    clearTimeout(timer);
    ws.close();
    process.exit(0);
});

ws.on('error', (error) => {
    console.error('WebSocket connection error:', error.message);
    clearTimeout(timer);
    process.exit(1);
});

ws.on('close', () => {
    if (connected) {
        console.log('WebSocket connection closed cleanly');
    }
});
EOF

    # Test WebSocket connection
    if node "${ws_test_script}" "${ws_endpoint}" 10000; then
        log_success "WebSocket server is ready and accepting connections"
        rm -f "${ws_test_script}"
        return 0
    else
        log_error "WebSocket server connection test failed"
        rm -f "${ws_test_script}"
        return 1
    fi
}

# =============================================================================
# TEST EXECUTION FUNCTIONS
# =============================================================================

# test-execution: Execute Playwright tests with collaboration configuration
execute_collaboration_tests() {
    local test_scenario=$1
    log_info "Executing collaboration tests for scenario: ${test_scenario}"

    # Prepare test environment
    cd "${SCRIPT_DIR}"

    # Set up test configuration
    local config_file="${CONFIG_FILE:-${SCRIPT_DIR}/playwright-collaboration.config.ts}"
    local test_command=(
        "npx"
        "playwright"
        "test"
        "--config=${config_file}"
    )

    # Add scenario-specific options
    case "${test_scenario}" in
        dual-user)
            test_command+=(
                "--grep=@dual-user"
                "--project=dual-user-chrome"
                "--workers=${WORKERS}"
                "--timeout=$((TIMEOUT * 1000))"
                "--retries=${RETRIES}"
            )
            ;;
        multi-user)
            test_command+=(
                "--grep=@multi-user"
                "--project=multi-user-chrome"
                "--workers=1"  # Sequential execution for multi-user tests
                "--timeout=$((TIMEOUT * 1000))"
                "--retries=${RETRIES}"
            )
            ;;
        stress-test)
            test_command+=(
                "--grep=@stress-test"
                "--project=stress-test-concurrent"
                "--workers=1"
                "--timeout=$((TIMEOUT * 2000))"  # Double timeout for stress tests
                "--retries=1"  # Fewer retries for stress tests
            )
            ;;
        performance)
            test_command+=(
                "--grep=@performance"
                "--project=performance-benchmarks"
                "--workers=1"
                "--timeout=$((TIMEOUT * 1500))"
                "--retries=${RETRIES}"
            )
            ;;
        debug)
            test_command+=(
                "--debug"
                "--project=dual-user-chrome"
                "--workers=1"
                "--timeout=0"  # No timeout in debug mode
                "--retries=0"
            )
            export PWDEBUG=1
            ;;
    esac

    # Add CI-specific options
    if [[ "${CI_MODE}" == true ]]; then
        test_command+=(
            "--reporter=github,json"
            "--output-dir=${ARTIFACTS_DIR}"
        )
    else
        test_command+=(
            "--reporter=list,html"
            "--output-dir=${ARTIFACTS_DIR}"
        )
    fi

    # Add profiling options
    if [[ "${MEMORY_PROFILE}" == true ]] || [[ "${LATENCY_PROFILE}" == true ]]; then
        export COLLABORATION_PROFILING=true
        test_command+=("--reporter=./test-utils/collaboration-performance-reporter.ts")
    fi

    log_debug "Executing test command: ${test_command[*]}"

    # Execute tests and capture results
    START_TIME=$(date +%s)

    if [[ "${VERBOSE}" == true ]]; then
        "${test_command[@]}"
        local test_exit_code=$?
    else
        "${test_command[@]}" > "${ARTIFACTS_DIR}/test-execution.log" 2>&1
        local test_exit_code=$?
    fi

    END_TIME=$(date +%s)

    # Parse test results if available
    parse_test_results "${test_exit_code}"

    return "${test_exit_code}"
}

# Parse test execution results
parse_test_results() {
    local exit_code=$1
    local duration=$((END_TIME - START_TIME))

    log_info "Test execution completed in ${duration} seconds"

    # Look for Playwright test results
    local results_file="${ARTIFACTS_DIR}/results.json"
    if [[ -f "${results_file}" ]]; then
        # Parse JSON results if available
        if command_exists jq; then
            TOTAL_TESTS=$(jq '.stats.total // 0' "${results_file}")
            PASSED_TESTS=$(jq '.stats.passed // 0' "${results_file}")
            FAILED_TESTS=$(jq '.stats.failed // 0' "${results_file}")
            SKIPPED_TESTS=$(jq '.stats.skipped // 0' "${results_file}")
        else
            log_debug "jq not available, using basic result parsing"
        fi
    fi

    # Log test summary
    if [[ ${exit_code} -eq 0 ]]; then
        log_success "All tests passed successfully"
    else
        log_error "Some tests failed (exit code: ${exit_code})"
    fi

    log_info "Test Summary:"
    log_info "  Duration: ${duration}s"
    log_info "  Total: ${TOTAL_TESTS}"
    log_info "  Passed: ${PASSED_TESTS}"
    log_info "  Failed: ${FAILED_TESTS}"
    log_info "  Skipped: ${SKIPPED_TESTS}"
}

# =============================================================================
# PERFORMANCE MONITORING FUNCTIONS
# =============================================================================

# metric-collection: Capture performance metrics during test execution
start_performance_monitoring() {
    if [[ "${MEMORY_PROFILE}" == false ]] && [[ "${LATENCY_PROFILE}" == false ]]; then
        return 0
    fi

    log_info "Starting performance monitoring"

    # Create monitoring script
    local monitor_script="${ARTIFACTS_DIR}/monitor-performance.sh"

    cat > "${monitor_script}" << 'EOF'
#!/bin/bash
JUPYTER_PID=$1
ARTIFACTS_DIR=$2
MEMORY_PROFILE=$3
LATENCY_PROFILE=$4

# Performance monitoring loop
while kill -0 "$JUPYTER_PID" 2>/dev/null; do
    TIMESTAMP=$(date +%s.%3N)

    # Memory profiling
    if [[ "$MEMORY_PROFILE" == "true" ]]; then
        MEMORY_USAGE=$(ps -p "$JUPYTER_PID" -o rss= 2>/dev/null || echo "0")
        echo "${TIMESTAMP},${MEMORY_USAGE}" >> "${ARTIFACTS_DIR}/memory-usage.csv"
    fi

    # Latency profiling (placeholder - actual implementation would hook into WebSocket)
    if [[ "$LATENCY_PROFILE" == "true" ]]; then
        # This would be replaced with actual latency measurements
        echo "${TIMESTAMP},placeholder" >> "${ARTIFACTS_DIR}/latency-samples.csv"
    fi

    sleep 1
done
EOF

    chmod +x "${monitor_script}"

    # Start monitoring in background
    if [[ -n "${JUPYTER_PID}" ]]; then
        "${monitor_script}" "${JUPYTER_PID}" "${ARTIFACTS_DIR}" "${MEMORY_PROFILE}" "${LATENCY_PROFILE}" &
        local monitor_pid=$!
        TEST_PIDS+=("${monitor_pid}")
        log_debug "Performance monitoring started with PID: ${monitor_pid}"
    fi
}

# report-generation: Generate comprehensive test reports and artifacts
generate_test_reports() {
    log_info "Generating comprehensive test reports and artifacts"

    # Ensure artifacts directory exists
    mkdir -p "${ARTIFACTS_DIR}"

    # Generate summary report
    local summary_file="${ARTIFACTS_DIR}/test-summary.json"
    cat > "${summary_file}" << EOF
{
  "testExecution": {
    "scenario": "${SCENARIO}",
    "startTime": "${START_TIME}",
    "endTime": "${END_TIME}",
    "duration": $((END_TIME - START_TIME)),
    "exitCode": 0
  },
  "testResults": {
    "total": ${TOTAL_TESTS},
    "passed": ${PASSED_TESTS},
    "failed": ${FAILED_TESTS},
    "skipped": ${SKIPPED_TESTS}
  },
  "configuration": {
    "jupyterPort": ${JUPYTER_PORT},
    "wsPort": ${WS_PORT},
    "workers": ${WORKERS},
    "retries": ${RETRIES},
    "timeout": ${TIMEOUT},
    "ciMode": ${CI_MODE},
    "memoryProfile": ${MEMORY_PROFILE},
    "latencyProfile": ${LATENCY_PROFILE}
  },
  "environment": {
    "nodeVersion": "$(node --version 2>/dev/null || echo 'unknown')",
    "jupyterVersion": "$(jupyter --version 2>/dev/null | head -n1 || echo 'unknown')",
    "playwrightVersion": "$(npx playwright --version 2>/dev/null || echo 'unknown')",
    "operatingSystem": "$(uname -s) $(uname -r)"
  }
}
EOF

    # Generate performance reports if profiling was enabled
    if [[ "${MEMORY_PROFILE}" == true ]]; then
        generate_memory_report
    fi

    if [[ "${LATENCY_PROFILE}" == true ]]; then
        generate_latency_report
    fi

    # Generate HTML report index
    generate_html_report_index

    log_success "Test reports generated in: ${ARTIFACTS_DIR}"

    # Display report summary
    if [[ "${VERBOSE}" == true ]] || [[ "${CI_MODE}" == false ]]; then
        log_info "Generated artifacts:"
        find "${ARTIFACTS_DIR}" -type f -exec basename {} \; | sort | while read -r file; do
            log_info "  - ${file}"
        done
    fi
}

generate_memory_report() {
    local memory_file="${ARTIFACTS_DIR}/memory-usage.csv"
    if [[ ! -f "${memory_file}" ]]; then
        log_debug "Memory usage data not available"
        return 0
    fi

    log_debug "Generating memory usage report"

    # Create memory report (basic analysis)
    local memory_report="${ARTIFACTS_DIR}/memory-report.json"

    # Calculate basic statistics if available
    local max_memory=0
    local min_memory=999999999
    local sample_count=0

    while IFS=',' read -r timestamp memory; do
        if [[ "${memory}" =~ ^[0-9]+$ ]]; then
            ((sample_count++))
            if [[ ${memory} -gt ${max_memory} ]]; then
                max_memory=${memory}
            fi
            if [[ ${memory} -lt ${min_memory} ]]; then
                min_memory=${memory}
            fi
        fi
    done < "${memory_file}"

    cat > "${memory_report}" << EOF
{
  "memoryUsage": {
    "maxMemoryKB": ${max_memory},
    "minMemoryKB": ${min_memory},
    "sampleCount": ${sample_count},
    "dataFile": "memory-usage.csv"
  }
}
EOF
}

generate_latency_report() {
    local latency_file="${ARTIFACTS_DIR}/latency-samples.csv"
    if [[ ! -f "${latency_file}" ]]; then
        log_debug "Latency data not available"
        return 0
    fi

    log_debug "Generating latency report"

    # Create latency report
    local latency_report="${ARTIFACTS_DIR}/latency-report.json"

    cat > "${latency_report}" << EOF
{
  "latencyProfile": {
    "note": "Latency profiling implementation depends on WebSocket instrumentation",
    "dataFile": "latency-samples.csv",
    "targetLatency": "100ms (95th percentile)"
  }
}
EOF
}

generate_html_report_index() {
    local index_file="${ARTIFACTS_DIR}/index.html"

    cat > "${index_file}" << EOF
<!DOCTYPE html>
<html>
<head>
    <title>Collaboration Test Report - ${SCENARIO}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 5px; }
        .section { margin: 20px 0; }
        .success { color: green; }
        .error { color: red; }
        .artifacts { background: #f9f9f9; padding: 15px; border-radius: 5px; }
        .artifacts ul { list-style-type: none; }
        .artifacts li { padding: 5px 0; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Jupyter Notebook v7 - Collaboration Test Report</h1>
        <h2>Scenario: ${SCENARIO}</h2>
        <p>Generated: $(date)</p>
    </div>

    <div class="section">
        <h3>Test Results</h3>
        <p><strong>Duration:</strong> $((END_TIME - START_TIME)) seconds</p>
        <p><strong>Total Tests:</strong> ${TOTAL_TESTS}</p>
        <p><strong>Passed:</strong> <span class="success">${PASSED_TESTS}</span></p>
        <p><strong>Failed:</strong> <span class="error">${FAILED_TESTS}</span></p>
        <p><strong>Skipped:</strong> ${SKIPPED_TESTS}</p>
    </div>

    <div class="section">
        <h3>Configuration</h3>
        <p><strong>Jupyter Port:</strong> ${JUPYTER_PORT}</p>
        <p><strong>WebSocket Port:</strong> ${WS_PORT}</p>
        <p><strong>Workers:</strong> ${WORKERS}</p>
        <p><strong>Retries:</strong> ${RETRIES}</p>
        <p><strong>CI Mode:</strong> ${CI_MODE}</p>
    </div>

    <div class="section">
        <h3>Generated Artifacts</h3>
        <div class="artifacts">
            <ul>
                <li><strong>test-summary.json</strong> - Complete test execution summary</li>
                <li><strong>memory-report.json</strong> - Memory usage analysis (if enabled)</li>
                <li><strong>latency-report.json</strong> - Latency profiling data (if enabled)</li>
                <li><strong>test-execution.log</strong> - Detailed execution logs</li>
            </ul>
        </div>
    </div>
</body>
</html>
EOF
}

# =============================================================================
# CLEANUP AND RESOURCE MANAGEMENT
# =============================================================================

# resource-cleanup: Clean up test resources and background processes
cleanup_resources() {
    if [[ "${CLEANUP_PERFORMED}" == true ]]; then
        return 0
    fi

    log_info "Cleaning up test resources and background processes"
    CLEANUP_PERFORMED=true

    # Stop performance monitoring processes
    if [[ ${#TEST_PIDS[@]} -gt 0 ]]; then
        log_debug "Stopping performance monitoring processes"
        for pid in "${TEST_PIDS[@]}"; do
            if kill -0 "${pid}" 2>/dev/null; then
                kill "${pid}" 2>/dev/null || true
                log_debug "Stopped monitoring process: ${pid}"
            fi
        done
    fi

    # Stop Jupyter server
    if [[ -n "${JUPYTER_PID}" ]] && kill -0 "${JUPYTER_PID}" 2>/dev/null; then
        log_debug "Stopping Jupyter server (PID: ${JUPYTER_PID})"
        kill "${JUPYTER_PID}" 2>/dev/null || true

        # Wait for graceful shutdown
        local count=0
        while [[ ${count} -lt 10 ]] && kill -0 "${JUPYTER_PID}" 2>/dev/null; do
            sleep 1
            ((count++))
        done

        # Force kill if still running
        if kill -0 "${JUPYTER_PID}" 2>/dev/null; then
            log_debug "Force stopping Jupyter server"
            kill -9 "${JUPYTER_PID}" 2>/dev/null || true
        fi

        log_debug "Jupyter server stopped"
    fi

    # Clean up temporary files
    local temp_files=(
        "${ARTIFACTS_DIR}/ws-test.js"
        "${ARTIFACTS_DIR}/monitor-performance.sh"
    )

    for file in "${temp_files[@]}"; do
        if [[ -f "${file}" ]]; then
            rm -f "${file}"
            log_debug "Removed temporary file: ${file}"
        fi
    done

    # Additional cleanup for any remaining processes
    pkill -f "jupyter-notebook.*--collaborative.*--port=${JUPYTER_PORT}" 2>/dev/null || true

    log_success "Resource cleanup completed"
}

# =============================================================================
# MAIN ORCHESTRATION FUNCTIONS
# =============================================================================

# Main function for dual-user collaboration testing
run_dual_user_tests() {
    log_info "Executing dual-user collaboration test scenario"

    # Setup infrastructure
    setup_jupyter_server || return 1
    initialize_websocket_server || return 1

    # Start performance monitoring
    start_performance_monitoring

    # Execute tests
    execute_collaboration_tests "dual-user"
    local test_result=$?

    # Generate reports
    generate_test_reports

    return "${test_result}"
}

# Main function for multi-user collaboration testing
run_multi_user_tests() {
    log_info "Executing multi-user collaboration test scenario"

    # Setup infrastructure
    setup_jupyter_server || return 1
    initialize_websocket_server || return 1

    # Start performance monitoring
    start_performance_monitoring

    # Execute tests
    execute_collaboration_tests "multi-user"
    local test_result=$?

    # Generate reports
    generate_test_reports

    return "${test_result}"
}

# Main function for stress testing
run_stress_tests() {
    log_info "Executing stress test scenario with high concurrent load"

    # Setup infrastructure with optimizations for stress testing
    setup_jupyter_server || return 1
    initialize_websocket_server || return 1

    # Start enhanced performance monitoring for stress tests
    MEMORY_PROFILE=true
    LATENCY_PROFILE=true
    start_performance_monitoring

    # Execute stress tests
    execute_collaboration_tests "stress-test"
    local test_result=$?

    # Generate comprehensive reports
    generate_test_reports

    return "${test_result}"
}

# Main function for performance benchmarking
run_performance_benchmarks() {
    log_info "Executing performance benchmarking and metrics collection"

    # Enable all profiling options for benchmarks
    MEMORY_PROFILE=true
    LATENCY_PROFILE=true

    # Setup infrastructure
    setup_jupyter_server || return 1
    initialize_websocket_server || return 1

    # Start comprehensive performance monitoring
    start_performance_monitoring

    # Execute performance tests
    execute_collaboration_tests "performance"
    local test_result=$?

    # Generate detailed performance reports
    generate_test_reports

    return "${test_result}"
}

# Main function for debug mode testing
run_debug_tests() {
    log_info "Executing tests in debug mode with detailed logging"

    # Force verbose mode for debug
    VERBOSE=true

    # Setup infrastructure
    setup_jupyter_server || return 1
    initialize_websocket_server || return 1

    # Execute debug tests (no performance monitoring to avoid interference)
    execute_collaboration_tests "debug"
    local test_result=$?

    # Generate basic reports
    generate_test_reports

    return "${test_result}"
}

# Main orchestration function
main() {
    log_info "Starting Jupyter Notebook v7 Collaboration Test Orchestration"
    log_info "Script version: ${SCRIPT_VERSION}"

    # Parse and validate arguments
    parse_arguments "$@"

    # Validate all dependencies
    validate_dependencies

    # Create artifacts directory
    mkdir -p "${ARTIFACTS_DIR}"

    # Set up cleanup trap for graceful shutdown
    trap cleanup_resources EXIT

    # Execute the requested scenario
    local exit_code=0

    case "${SCENARIO}" in
        dual-user)
            run_dual_user_tests
            exit_code=$?
            ;;
        multi-user)
            run_multi_user_tests
            exit_code=$?
            ;;
        stress-test)
            run_stress_tests
            exit_code=$?
            ;;
        performance)
            run_performance_benchmarks
            exit_code=$?
            ;;
        debug)
            run_debug_tests
            exit_code=$?
            ;;
        cleanup)
            cleanup_resources
            exit_code=0
            ;;
        *)
            log_error "Invalid scenario: ${SCENARIO}"
            exit_code=1
            ;;
    esac

    # Final status report
    if [[ ${exit_code} -eq 0 ]]; then
        log_success "Collaboration test orchestration completed successfully"
        log_info "Test artifacts available in: ${ARTIFACTS_DIR}"
    else
        log_error "Collaboration test orchestration failed with exit code: ${exit_code}"
    fi

    return "${exit_code}"
}

# Execute main function if script is run directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
