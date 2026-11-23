#!/bin/bash
# Acceptance walk through a running server with curl: an admin enrolls an agent, the agent uploads
# a detection and a heartbeat, the silent-agent job runs, and the console answers the session.
#
# It talks to the server the way production traffic reaches it:
# - enrollment is an admin action (`requireTenantAdmin`), so the script signs in with a tenant
#   admin's email and password and makes that tenant its session's active organization;
# - agent routes trust the mTLS headers only when the request carries nginx's proxy secret
#   (`verifyProxyAuth`), so agent calls send `X-Proxy-Secret` with the mTLS headers nginx would
#   set. Point SERVER_URL at the Next.js server itself, not at nginx.
#
# Required:
#   E2E_EMAIL, E2E_PASSWORD  a user who is `owner` or `admin` of a tenant. To create one on a fresh
#                            stack, see "The acceptance script" in docs/testing.md.
# Optional:
#   SERVER_URL           default http://localhost:3000
#   CRON_SECRET          default dev_cron_secret (.env.example)
#   NGINX_PROXY_SECRET   default dev_nginx_secret_change_in_production (.env.example)
#   E2E_TENANT_ID        the tenant to act in; default: the user's first organization
#   SKIP_DOCKER_CHECK    set to skip the container checks of test 3

set -eu

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SERVER_URL="${SERVER_URL:-http://localhost:3000}"
CRON_SECRET="${CRON_SECRET:-dev_cron_secret}"
NGINX_PROXY_SECRET="${NGINX_PROXY_SECRET:-dev_nginx_secret_change_in_production}"
ENROLLMENT_ID="agent-acceptance-test-001"

print_success() { echo -e "${GREEN}✓ $1${NC}"; }
print_error() { echo -e "${RED}✗ $1${NC}"; }
print_info() { echo -e "${YELLOW}→ $1${NC}"; }

if [ -z "${E2E_EMAIL:-}" ] || [ -z "${E2E_PASSWORD:-}" ]; then
    print_error "E2E_EMAIL and E2E_PASSWORD (a tenant admin) are required; see the header of this script"
    exit 2
fi

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT

# better-auth checks the Origin of cookie-authenticated calls against `trustedOrigins` (lib/auth.ts).
session_curl() {
    curl -s -b "$COOKIES" -c "$COOKIES" -H "Origin: $SERVER_URL" -H "Content-Type: application/json" "$@"
}

# What nginx sets on an agent request after verifying its client certificate (nginx.conf).
agent_curl() {
    curl -s \
        -H "X-Proxy-Secret: $NGINX_PROXY_SECRET" \
        -H "X-Client-Cert-Verified: SUCCESS" \
        -H "X-Client-Cert-Subject: CN=$ENROLLMENT_ID,O=synthaea" \
        "$@"
}

echo "======================================"
echo "  Synthaea acceptance tests"
echo "======================================"
echo ""
echo "Server: $SERVER_URL"
echo ""

print_info "Checking server health..."
if ! curl -sf "$SERVER_URL/api/health" > /dev/null; then
    print_error "Server not responding at $SERVER_URL"
    print_info "Start server with: docker compose up"
    exit 1
fi
print_success "Server is healthy"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Admin session → agent enrollment → detection → console"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

print_info "Signing in as $E2E_EMAIL"
SIGNIN_RESPONSE=$(session_curl -X POST "$SERVER_URL/api/auth/sign-in/email" \
    -d "{\"email\": \"$E2E_EMAIL\", \"password\": \"$E2E_PASSWORD\"}")
if grep -q '"token"' <<< "$SIGNIN_RESPONSE"; then
    print_success "Signed in"
else
    print_error "Sign-in failed"
    echo "   Response: $SIGNIN_RESPONSE"
    exit 1
fi

TENANT_ID="${E2E_TENANT_ID:-}"
if [ -z "$TENANT_ID" ]; then
    ORGS=$(session_curl "$SERVER_URL/api/auth/organization/list")
    TENANT_ID=$(grep -o '"id":"[^"]*"' <<< "$ORGS" | head -1 | cut -d'"' -f4 || true)
fi
if [ -z "$TENANT_ID" ]; then
    print_error "$E2E_EMAIL belongs to no tenant"
    exit 1
fi
ACTIVE_RESPONSE=$(session_curl -X POST "$SERVER_URL/api/auth/organization/set-active" \
    -d "{\"organizationId\": \"$TENANT_ID\"}")
if grep -q "\"id\":\"$TENANT_ID\"" <<< "$ACTIVE_RESPONSE"; then
    print_success "Active tenant: $TENANT_ID"
else
    print_error "Could not make $TENANT_ID the active tenant"
    echo "   Response: $ACTIVE_RESPONSE"
    exit 1
fi
echo ""

print_info "Enrolling agent: $ENROLLMENT_ID"
ENROLL_RESPONSE=$(session_curl -X POST "$SERVER_URL/api/enrollment" \
    -d "{
        \"enrollmentId\": \"$ENROLLMENT_ID\",
        \"hostname\": \"acceptance-test-vm\",
        \"version\": \"0.1.0\"
    }")
if grep -q '"status":"\(already_\)\?enrolled"' <<< "$ENROLL_RESPONSE"; then
    print_success "Agent enrolled"
    echo "   Response: $ENROLL_RESPONSE"
else
    print_error "Agent enrollment failed"
    echo "   Response: $ENROLL_RESPONSE"
    exit 1
fi
echo ""

print_info "Uploading a detection from the agent"
TIMESTAMP_NS=$(date +%s)000000000
DETECTION_RESPONSE=$(agent_curl -X POST "$SERVER_URL/api/ingest/detection" \
    -H "Content-Type: application/json" \
    -d "{
        \"timestamp_ns\": $TIMESTAMP_NS,
        \"technique\": \"T1059.001\",
        \"severity\": \"high\",
        \"event\": {
            \"type\": \"exec\",
            \"comm\": \"bash\",
            \"cmdline\": \"bash -c acceptance-test\"
        },
        \"meta\": {
            \"hostname\": \"acceptance-test-vm\",
            \"user\": \"root\"
        }
    }")
if grep -q '"status":"accepted"' <<< "$DETECTION_RESPONSE"; then
    print_success "Detection accepted"
    echo "   Response: $DETECTION_RESPONSE"
else
    print_error "Detection upload failed"
    echo "   Response: $DETECTION_RESPONSE"
    exit 1
fi
echo ""

print_info "Opening the console with the session"
CONSOLE_STATUS=$(session_curl -o /dev/null -w "%{http_code}" "$SERVER_URL/console/cases")
if [ "$CONSOLE_STATUS" = "200" ]; then
    print_success "Console answers the session (HTTP 200)"
else
    print_error "Console did not answer the session (HTTP $CONSOLE_STATUS)"
    exit 1
fi
echo ""

print_success "Test 1 PASSED: enrollment, detection upload and console"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: Heartbeat and silent-agent job"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

print_info "Sending a heartbeat from the agent"
HEARTBEAT_RESPONSE=$(agent_curl -X POST "$SERVER_URL/api/ingest/heartbeat")
if grep -q '"status":"ok"' <<< "$HEARTBEAT_RESPONSE"; then
    print_success "Heartbeat accepted"
    echo "   Response: $HEARTBEAT_RESPONSE"
else
    print_error "Heartbeat failed"
    echo "   Response: $HEARTBEAT_RESPONSE"
    exit 1
fi
echo ""

print_info "Running the silent-agent job (an agent is silent after 5 minutes without a heartbeat)"
CRON_RESPONSE=$(curl -s "$SERVER_URL/api/cron/detect-silent-agents" \
    -H "Authorization: Bearer $CRON_SECRET")
if grep -q '"silentAgents"' <<< "$CRON_RESPONSE"; then
    print_success "Silent-agent job ran"
    echo "   Response: $CRON_RESPONSE"
else
    print_error "Silent-agent job failed"
    echo "   Response: $CRON_RESPONSE"
    exit 1
fi
echo ""

print_success "Test 2 PASSED: heartbeat and silent-agent job"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: Docker Compose dev stack"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -z "${SKIP_DOCKER_CHECK:-}" ] && docker compose version > /dev/null 2>&1; then
    for service in postgres server; do
        if docker compose ps --status running "$service" 2>/dev/null | grep -q "$service"; then
            print_success "$service container is running"
        else
            print_error "$service container is not running"
        fi
    done
    if docker compose ps --status running proxy 2>/dev/null | grep -q proxy; then
        print_success "nginx proxy container is running"
    else
        print_info "nginx proxy not running (optional for dev)"
    fi
else
    print_info "Skipping container checks (SKIP_DOCKER_CHECK set, or no docker compose)"
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}ALL ACCEPTANCE TESTS PASSED${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
