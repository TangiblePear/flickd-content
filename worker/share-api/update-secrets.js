const fs = require('fs');
const { spawnSync } = require('child_process');

const jsonPath = "C:\\Users\\reser\\Workspaces\\Media Remote\\flickto-cf7b6-firebase-adminsdk-fbsvc-139a0db7bc.json";
const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

function putSecret(name, value) {
    console.log(`Setting ${name}...`);
    const proc = spawnSync('cmd.exe', ['/c', 'npx wrangler secret put ' + name], {
        input: value,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
    });
    if (proc.status !== 0) {
        console.error(`Error setting ${name}:`, proc.stderr);
    } else {
        console.log(`Success setting ${name}`);
    }
}

putSecret('FCM_PROJECT_ID', json.project_id);
putSecret('FCM_SERVICE_ACCOUNT_EMAIL', json.client_email);
putSecret('FCM_PRIVATE_KEY', json.private_key);
