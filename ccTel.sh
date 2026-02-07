#!/bin/bash

# Claude Code Privacy Configuration Checker and Manager
# This script checks and manages privacy settings for Claude Code

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Privacy environment variables
PRIVACY_VARS=(
    "DISABLE_TELEMETRY=1"
    "DISABLE_ERROR_REPORTING=1"
    "DISABLE_BUG_COMMAND=1"
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"
)

# Function to print colored output
print_status() {
    local status=$1
    local message=$2
    
    if [ "$status" = "success" ]; then
        echo -e "${GREEN}✓${NC} $message"
    elif [ "$status" = "error" ]; then
        echo -e "${RED}✗${NC} $message"
    elif [ "$status" = "warning" ]; then
        echo -e "${YELLOW}⚠${NC} $message"
    else
        echo -e "${BLUE}ℹ${NC} $message"
    fi
}

# Function to check environment variables
check_env_vars() {
    echo -e "\n${BLUE}=== Checking Current Environment Variables ===${NC}"
    local all_set=true
    
    for var_setting in "${PRIVACY_VARS[@]}"; do
        var_name="${var_setting%=*}"
        expected_value="${var_setting#*=}"
        current_value="${!var_name}"
        
        if [ "$current_value" = "$expected_value" ]; then
            print_status "success" "$var_name is set to $expected_value"
        else
            print_status "error" "$var_name is not set (current: '${current_value:-not set}')"
            all_set=false
        fi
    done
    
    return $([ "$all_set" = true ] && echo 0 || echo 1)
}

# Function to check settings in .bashrc
check_bashrc() {
    echo -e "\n${BLUE}=== Checking ~/.bashrc ===${NC}"
    local bashrc_file="$HOME/.bashrc"
    local all_found=true
    
    if [ ! -f "$bashrc_file" ]; then
        print_status "error" "~/.bashrc does not exist"
        return 1
    fi
    
    for var_setting in "${PRIVACY_VARS[@]}"; do
        var_name="${var_setting%=*}"
        if grep -q "export $var_setting" "$bashrc_file"; then
            print_status "success" "$var_name found in ~/.bashrc"
        else
            print_status "error" "$var_name not found in ~/.bashrc"
            all_found=false
        fi
    done
    
    return $([ "$all_found" = true ] && echo 0 || echo 1)
}

# Function to check settings in .zshrc
check_zshrc() {
    echo -e "\n${BLUE}=== Checking ~/.zshrc ===${NC}"
    local zshrc_file="$HOME/.zshrc"
    
    if [ ! -f "$zshrc_file" ]; then
        print_status "warning" "~/.zshrc does not exist (not required if using bash)"
        return 2
    fi
    
    local all_found=true
    for var_setting in "${PRIVACY_VARS[@]}"; do
        var_name="${var_setting%=*}"
        if grep -q "export $var_setting" "$zshrc_file"; then
            print_status "success" "$var_name found in ~/.zshrc"
        else
            print_status "error" "$var_name not found in ~/.zshrc"
            all_found=false
        fi
    done
    
    return $([ "$all_found" = true ] && echo 0 || echo 1)
}

# Function to check settings.json (both global and project)
check_settings_json() {
    echo -e "\n${BLUE}=== Checking Claude Settings Files ===${NC}"
    local global_settings="$HOME/.claude/settings.json"
    local project_settings="./.claude/settings.json"
    local global_status=1
    local project_status=1
    
    # Check global settings
    echo -e "${BLUE}Global settings (~/.claude/settings.json):${NC}"
    if [ ! -f "$global_settings" ]; then
        print_status "warning" "Global settings file does not exist"
    else
        local all_found=true
        for var_setting in "${PRIVACY_VARS[@]}"; do
            var_name="${var_setting%=*}"
            expected_value="${var_setting#*=}"
            
            if python3 -c "
import json, sys
try:
    with open('$global_settings', 'r') as f:
        data = json.load(f)
    env = data.get('env', {})
    sys.exit(0 if env.get('$var_name') == '$expected_value' else 1)
except:
    sys.exit(1)
" 2>/dev/null; then
                print_status "success" "  $var_name configured"
            else
                print_status "error" "  $var_name not configured"
                all_found=false
            fi
        done
        [ "$all_found" = true ] && global_status=0
    fi
    
    # Check project settings
    echo -e "\n${BLUE}Project settings (./.claude/settings.json):${NC}"
    if [ ! -f "$project_settings" ]; then
        print_status "info" "Project settings file does not exist (optional)"
    else
        local all_found=true
        for var_setting in "${PRIVACY_VARS[@]}"; do
            var_name="${var_setting%=*}"
            expected_value="${var_setting#*=}"
            
            if python3 -c "
import json, sys
try:
    with open('$project_settings', 'r') as f:
        data = json.load(f)
    env = data.get('env', {})
    sys.exit(0 if env.get('$var_name') == '$expected_value' else 1)
except:
    sys.exit(1)
" 2>/dev/null; then
                print_status "success" "  $var_name configured"
            else
                print_status "error" "  $var_name not configured"
                all_found=false
            fi
        done
        [ "$all_found" = true ] && project_status=0
    fi
    
    # Return success if either is configured
    return $([ "$global_status" = 0 ] || [ "$project_status" = 0 ] && echo 0 || echo 1)
}

# Function to add settings to .bashrc
add_to_bashrc() {
    local bashrc_file="$HOME/.bashrc"
    
    echo -e "\n${BLUE}Adding privacy settings to ~/.bashrc...${NC}"
    
    # Check if the privacy section already exists
    if grep -q "# Claude Code Privacy Settings" "$bashrc_file" 2>/dev/null; then
        print_status "warning" "Privacy settings section already exists in ~/.bashrc"
        echo "Do you want to replace it? (y/n): "
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            # Remove existing section
            sed -i '/# Claude Code Privacy Settings/,/^$/d' "$bashrc_file"
        else
            return 0
        fi
    fi
    
    # Add the privacy settings
    cat >> "$bashrc_file" << 'EOF'

# Claude Code Privacy Settings
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

EOF
    
    print_status "success" "Privacy settings added to ~/.bashrc"
}

# Function to add settings to .zshrc
add_to_zshrc() {
    local zshrc_file="$HOME/.zshrc"
    
    if [ ! -f "$zshrc_file" ]; then
        print_status "warning" "~/.zshrc does not exist, skipping"
        return 0
    fi
    
    echo -e "\n${BLUE}Adding privacy settings to ~/.zshrc...${NC}"
    
    # Check if the privacy section already exists
    if grep -q "# Claude Code Privacy Settings" "$zshrc_file"; then
        print_status "warning" "Privacy settings section already exists in ~/.zshrc"
        echo "Do you want to replace it? (y/n): "
        read -r response
        if [[ "$response" =~ ^[Yy]$ ]]; then
            # Remove existing section
            sed -i '/# Claude Code Privacy Settings/,/^$/d' "$zshrc_file"
        else
            return 0
        fi
    fi
    
    # Add the privacy settings
    cat >> "$zshrc_file" << 'EOF'

# Claude Code Privacy Settings
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1
export DISABLE_BUG_COMMAND=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

EOF
    
    print_status "success" "Privacy settings added to ~/.zshrc"
}

# Function to add/update settings.json (both global and project)
add_to_settings_json() {
    echo -e "\n${BLUE}Configuring Claude settings files...${NC}"
    
    # Ask user which to configure
    echo "Which settings file would you like to configure?"
    echo "1) Global settings (~/.claude/settings.json) - affects all projects"
    echo "2) Project settings (./.claude/settings.json) - affects current project only"
    echo "3) Both"
    echo -n "Enter choice (1-3): "
    read -r choice
    
    case $choice in
        1|3)
            # Configure global settings
            local global_dir="$HOME/.claude"
            local global_file="$global_dir/settings.json"
            
            echo -e "\n${BLUE}Updating global settings...${NC}"
            
            # Create directory if it doesn't exist
            if [ ! -d "$global_dir" ]; then
                mkdir -p "$global_dir"
                print_status "info" "Created ~/.claude directory"
            fi
            
            # Update global settings
            if python3 -c "
import json
import os

settings_file = os.path.expanduser('$global_file')
settings = {}

# Try to load existing settings
if os.path.exists(settings_file):
    try:
        with open(settings_file, 'r') as f:
            settings = json.load(f)
    except json.JSONDecodeError:
        print('Warning: Existing global settings.json is invalid, creating new one')

# Ensure 'env' section exists
if 'env' not in settings:
    settings['env'] = {}

# Add privacy settings
settings['env'].update({
    'DISABLE_TELEMETRY': '1',
    'DISABLE_ERROR_REPORTING': '1',
    'DISABLE_BUG_COMMAND': '1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'
})

# Write the updated settings
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)

print('Global settings updated successfully')
"; then
                print_status "success" "Privacy settings added to global settings.json"
            else
                print_status "error" "Failed to update global settings.json"
            fi
            ;;
    esac
    
    case $choice in
        2|3)
            # Configure project settings
            local project_dir="./.claude"
            local project_file="$project_dir/settings.json"
            
            echo -e "\n${BLUE}Updating project settings...${NC}"
            
            # Create directory if it doesn't exist
            if [ ! -d "$project_dir" ]; then
                mkdir -p "$project_dir"
                print_status "info" "Created ./.claude directory"
            fi
            
            # Update project settings
            if python3 -c "
import json
import os

settings_file = '$project_file'
settings = {}

# Try to load existing settings
if os.path.exists(settings_file):
    try:
        with open(settings_file, 'r') as f:
            settings = json.load(f)
    except json.JSONDecodeError:
        print('Warning: Existing project settings.json is invalid, creating new one')

# Ensure 'env' section exists
if 'env' not in settings:
    settings['env'] = {}

# Add privacy settings
settings['env'].update({
    'DISABLE_TELEMETRY': '1',
    'DISABLE_ERROR_REPORTING': '1',
    'DISABLE_BUG_COMMAND': '1',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'
})

# Write the updated settings
with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)

print('Project settings updated successfully')
"; then
                print_status "success" "Privacy settings added to project settings.json"
            else
                print_status "error" "Failed to update project settings.json"
            fi
            ;;
        *)
            print_status "error" "Invalid choice"
            return 1
            ;;
    esac
}

# Function to display summary
display_summary() {
    echo -e "\n${BLUE}══════════════════════════════════════════════${NC}"
    echo -e "${BLUE}           PRIVACY STATUS SUMMARY              ${NC}"
    echo -e "${BLUE}══════════════════════════════════════════════${NC}"
    
    local all_good=true
    
    # Check each component
    if check_env_vars >/dev/null 2>&1; then
        echo -e "Environment Variables: ${GREEN}✓ Configured${NC}"
    else
        echo -e "Environment Variables: ${RED}✗ Not Configured${NC}"
        all_good=false
    fi
    
    if check_bashrc >/dev/null 2>&1; then
        echo -e "~/.bashrc:            ${GREEN}✓ Configured${NC}"
    else
        echo -e "~/.bashrc:            ${RED}✗ Not Configured${NC}"
        all_good=false
    fi
    
    if [ -f "$HOME/.zshrc" ]; then
        if check_zshrc >/dev/null 2>&1; then
            echo -e "~/.zshrc:             ${GREEN}✓ Configured${NC}"
        else
            echo -e "~/.zshrc:             ${RED}✗ Not Configured${NC}"
            all_good=false
        fi
    fi
    
    # Check settings files
    local global_settings="$HOME/.claude/settings.json"
    local project_settings="./.claude/settings.json"
    local settings_ok=false
    
    if [ -f "$global_settings" ]; then
        if python3 -c "
import json
with open('$global_settings', 'r') as f:
    data = json.load(f)
env = data.get('env', {})
all_set = all([
    env.get('DISABLE_TELEMETRY') == '1',
    env.get('DISABLE_ERROR_REPORTING') == '1',
    env.get('DISABLE_BUG_COMMAND') == '1',
    env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') == '1'
])
exit(0 if all_set else 1)
" 2>/dev/null; then
            echo -e "Global settings:      ${GREEN}✓ Configured${NC}"
            settings_ok=true
        else
            echo -e "Global settings:      ${RED}✗ Not Configured${NC}"
        fi
    else
        echo -e "Global settings:      ${YELLOW}⚠ Not Found${NC}"
    fi
    
    if [ -f "$project_settings" ]; then
        if python3 -c "
import json
with open('$project_settings', 'r') as f:
    data = json.load(f)
env = data.get('env', {})
all_set = all([
    env.get('DISABLE_TELEMETRY') == '1',
    env.get('DISABLE_ERROR_REPORTING') == '1',
    env.get('DISABLE_BUG_COMMAND') == '1',
    env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC') == '1'
])
exit(0 if all_set else 1)
" 2>/dev/null; then
            echo -e "Project settings:     ${GREEN}✓ Configured${NC}"
            settings_ok=true
        else
            echo -e "Project settings:     ${RED}✗ Not Configured${NC}"
        fi
    else
        echo -e "Project settings:     ${BLUE}ℹ Not Found (optional)${NC}"
    fi
    
    if [ "$settings_ok" = false ]; then
        all_good=false
    fi
    
    echo -e "${BLUE}══════════════════════════════════════════════${NC}"
    
    if [ "$all_good" = true ]; then
        echo -e "\n${GREEN}✓ All privacy settings are properly configured!${NC}"
        echo -e "${GREEN}Claude Code telemetry is DISABLED.${NC}"
    else
        echo -e "\n${YELLOW}⚠ Some privacy settings are missing.${NC}"
        echo -e "${YELLOW}Run this script with 'add' to configure them.${NC}"
    fi
}

# Main script logic
case "${1:-check}" in
    check)
        echo -e "${BLUE}Claude Code Privacy Configuration Checker${NC}"
        echo -e "${BLUE}===========================================${NC}"
        
        check_env_vars
        check_bashrc
        check_zshrc
        check_settings_json
        display_summary
        ;;
        
    add)
        echo -e "${BLUE}Claude Code Privacy Configuration Manager${NC}"
        echo -e "${BLUE}==========================================${NC}"
        echo -e "\nThis will add privacy settings to your configuration files."
        echo "Continue? (y/n): "
        read -r response
        
        if [[ "$response" =~ ^[Yy]$ ]]; then
            add_to_bashrc
            add_to_zshrc
            add_to_settings_json
            
            echo -e "\n${GREEN}Configuration complete!${NC}"
            echo -e "${YELLOW}Note: You need to reload your shell or run 'source ~/.bashrc' for environment variables to take effect.${NC}"
            
            # Set variables for current session
            for var_setting in "${PRIVACY_VARS[@]}"; do
                export $var_setting
            done
            
            echo -e "\n${GREEN}Environment variables have been set for the current session.${NC}"
            display_summary
        else
            echo "Operation cancelled."
        fi
        ;;
        
    *)
        echo "Usage: $0 [check|add]"
        echo "  check - Check current privacy settings (default)"
        echo "  add   - Add privacy settings to configuration files"
        exit 1
        ;;
esac
