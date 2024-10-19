const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const modeFile = path.join(__dirname, 'trading-mode.txt');

function startTrading(mode) {
    console.log(`Starting trading in ${mode} mode...`);
    if (mode === 'surf') {
        require('./surf.js');
    } else if (mode === 'wave') {
        console.log("Wave mode is not finalized yet. Please use 'surf' mode for now.");
        process.exit(1);
        //require('./wave.js');
    } else {
        console.error(`Invalid mode: ${mode}`);
        process.exit(1);
    }
}

function promptForMode() {
    rl.question('Enter trading mode (surf/wave): ', (answer) => {
        const mode = answer.toLowerCase().trim();
        if (mode === 'surf' || mode === 'wave') {
            fs.writeFileSync(modeFile, mode);
            rl.close();
            startTrading(mode);
        } else {
            console.log('Invalid input. Please enter either "surf" or "wave".');
            promptForMode();
        }
    });
}

// Check if mode is saved
if (fs.existsSync(modeFile)) {
    const savedMode = fs.readFileSync(modeFile, 'utf8').trim();
    console.log(`Last used mode: ${savedMode}`);
    rl.question(`Do you want to continue with ${savedMode} mode? (Y/n): `, (answer) => {
        if (answer.toLowerCase() === 'n') {
            promptForMode();
        } else {
            rl.close();
            startTrading(savedMode);
        }
    });
} else {
    console.log('No previous trading mode found.');
    promptForMode();
}