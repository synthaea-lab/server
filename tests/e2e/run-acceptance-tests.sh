#!/bin/bash
# Acceptance walk through a running server with curl: an admin enrolls an agent, the agent uploads
# a detection and a heartbeat, the silent-agent job runs, and the console answers the session.
#
# It talks to the server the way production traffic reaches it:
# - enrollment is an admin action (`requireTenantAdmin`), so the script signs in with a tenant
#   admin's email and password and makes that tenant its session's active organization;
# - agent routes trust the mTLS headers only when the request carries nginx's proxy secret
#   (`verifyProxyAuth`), so agent calls send `X-Proxy-Secret` with the mTLS headers nginx would
#   set. Point SERVER_URL at the Next.js server itself, not at nginx, and run that server with
#   NGINX_PROXY_SECRET set: without it every agent call is refused.
#
# Required:
#   E2E_EMAIL, E2E_PASSWORD  a user who is `owner` or `admin` of a tenant. To create one on a fresh
#                            stack, see "Create the first account and tenant" in README-SETUP.md.
# Optional:
#   SERVER_URL           default http://localhost:3000 (it is also the Origin sent to better-auth,
#                        so it must be one of `trustedOrigins` in lib/auth.ts: http://localhost:3000
#                        or http://localhost:8443; http://127.0.0.1:3000 is refused at sign-in)
#   CRON_SECRET          default dev_cron_secret (.env.example)
#   NGINX_PROXY_SECRET   default dev_nginx_secret_change_in_production (.env.example)
#   E2E_TENANT_ID        the tenant to act in; default: the user's first organization
#   SKIP_DOCKER_CHECK    set to skip the container report of test 3

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

fail() {
    print_error "$1"
    exit 1
}

# Passes when RESPONSE matches the extended regex PATTERN; otherwise prints it and stops the run.
expect_response() {
    local step=$1 pattern=$2 response=$3
    if grep -Eq "$pattern" <<< "$response"; then
        print_success "$step"
        echo "   Response: $response"
    else
        print_error "$step: unexpected response"
        echo "   Response: $response"
        exit 1
    fi
}

if [ -z "${E2E_EMAIL:-}" ] || [ -z "${E2E_PASSWORD:-}" ]; then
    print_error "E2E_EMAIL and E2E_PASSWORD (a tenant admin) are required; see the header of this script"
    exit 2
fi

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT

# -sS: quiet, but curl's own error (refused, reset, timeout) still reaches stderr.
# better-auth checks the Origin of cookie-authenticated calls against `trustedOrigins` (lib/auth.ts).
session_curl() {
    curl -sS -b "$COOKIES" -c "$COOKIES" -H "Origin: $SERVER_URL" -H "Content-Type: application/json" "$@"
}

# A `header = "..."` line for `curl --config -`: the secret reaches curl on stdin, so it never
# appears in curl's argv (`ps`), like the sign-in body below. `\` and `"` are escaped as the
# config format requires. Not `-H @<(...)`: Git Bash's native curl cannot open /dev/fd paths.
secret_header() {
    printf 'header = "%s"\n' "$(printf '%s: %s' "$1" "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

# curl with one secret header on stdin, so the secret stays out of curl's argv. curl's stdin is
# taken by the header, so a caller cannot also send its body with `-d @-`.
curl_with_secret_header() {   # $1 = header name, $2 = its value, then curl's arguments
    local name=$1 value=$2
    shift 2
    secret_header "$name" "$value" | curl -sS --config - "$@"
}

# What nginx sets on an agent request after verifying its client certificate (nginx.conf).
agent_curl() {
    curl_with_secret_header X-Proxy-Secret "$NGINX_PROXY_SECRET" \
        -H "X-Client-Cert-Verified: SUCCESS" \
        -H "X-Client-Cert-Subject: CN=$ENROLLMENT_ID,O=synthaea" \
        "$@"
}

# The sign-in body, JSON-encoded from the environment: a password with `"` or `\` stays valid
# JSON, and it never appears in curl's argv (`ps`).
credentials_json() {
    node -e 'process.stdout.write(JSON.stringify({ email: process.env.E2E_EMAIL, password: process.env.E2E_PASSWORD }))'
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
    # `docker compose up` alone publishes only nginx (8443), not the server's 3000.
    print_info "Start the server with \`npm run dev\`, or the stack with port 3000 published (README-SETUP.md, \"Create the first account and tenant\")"
    exit 1
fi
print_success "Server is healthy"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 1: Admin session → agent enrollment → detection → console"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

print_info "Signing in as $E2E_EMAIL"
BODY=$(credentials_json) || fail "Could not build the sign-in body (is node installed?)"
SIGNIN_RESPONSE=$(session_curl -X POST "$SERVER_URL/api/auth/sign-in/email" --data-binary @- <<< "$BODY") \
    || fail "Sign-in: curl failed"
if grep -q '"token"' <<< "$SIGNIN_RESPONSE"; then
    print_success "Signed in"
else
    print_error "Sign-in failed"
    echo "   Response: $SIGNIN_RESPONSE"
    exit 1
fi

TENANT_ID="${E2E_TENANT_ID:-}"
if [ -z "$TENANT_ID" ]; then
    ORGS=$(session_curl "$SERVER_URL/api/auth/organization/list") || fail "Listing tenants: curl failed"
    TENANT_ID=$(node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
            const orgs = JSON.parse(s);
            if (Array.isArray(orgs) && orgs.length > 0) process.stdout.write(String(orgs[0].id));
        });' <<< "$ORGS") || fail "Listing tenants: unexpected response: $ORGS"
fi
[ -n "$TENANT_ID" ] || fail "$E2E_EMAIL belongs to no tenant"
ACTIVE_RESPONSE=$(session_curl -X POST "$SERVER_URL/api/auth/organization/set-active" \
    -d "{\"organizationId\": \"$TENANT_ID\"}") || fail "Setting the active tenant: curl failed"
expect_response "Active tenant: $TENANT_ID" "\"id\":\"$TENANT_ID\"" "$ACTIVE_RESPONSE"
echo ""

print_info "Enrolling agent: $ENROLLMENT_ID"
ENROLL_RESPONSE=$(session_curl -X POST "$SERVER_URL/api/enrollment" \
    -d "{
        \"enrollmentId\": \"$ENROLLMENT_ID\",
        \"hostname\": \"acceptance-test-vm\",
        \"version\": \"0.1.0\"
    }") || fail "Enrollment: curl failed"
expect_response "Agent enrolled" '"status":"(already_)?enrolled"' "$ENROLL_RESPONSE"
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
    }") || fail "Detection upload: curl failed"
expect_response "Detection accepted" '"status":"accepted"' "$DETECTION_RESPONSE"
echo ""

print_info "Opening the console with the session"
CONSOLE_STATUS=$(session_curl -o /dev/null -w "%{http_code}" "$SERVER_URL/console/cases") \
    || fail "Console: curl failed"
[ "$CONSOLE_STATUS" = "200" ] || fail "Console did not answer the session (HTTP $CONSOLE_STATUS)"
print_success "Console answers the session (HTTP 200)"
echo ""

print_success "Test 1 PASSED: enrollment, detection upload and console"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 2: Heartbeat and silent-agent job"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

print_info "Sending a heartbeat from the agent"
HEARTBEAT_RESPONSE=$(agent_curl -X POST "$SERVER_URL/api/ingest/heartbeat") || fail "Heartbeat: curl failed"
expect_response "Heartbeat accepted" '"status":"ok"' "$HEARTBEAT_RESPONSE"
echo ""

print_info "Running the silent-agent job (an agent is silent after 5 minutes without a heartbeat)"
CRON_RESPONSE=$(curl_with_secret_header Authorization "Bearer $CRON_SECRET" \
    "$SERVER_URL/api/cron/detect-silent-agents") || fail "Silent-agent job: curl failed"
expect_response "Silent-agent job ran" '"silentAgents"' "$CRON_RESPONSE"
echo ""

print_success "Test 2 PASSED: heartbeat and silent-agent job"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test 3: Docker Compose dev stack (report only)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Information, not a check: the HTTP steps above already proved the server and its database
# answer, and the server may well run outside the stack (`npm run dev`).
if [ -n "${SKIP_DOCKER_CHECK:-}" ]; then
    print_info "Container report skipped (SKIP_DOCKER_CHECK is set)"
elif ! docker compose version > /dev/null 2>&1; then
    print_info "Container report skipped (no docker compose on this host)"
else
    for service in postgres server proxy; do
        if docker compose ps --status running "$service" 2>/dev/null | grep -q "$service"; then
            print_info "$service container is running"
        else
            print_info "$service container is not running in this stack"
        fi
    done
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}ALL ACCEPTANCE TESTS PASSED${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
