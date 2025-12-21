
const pattern = /[A-Za-z0-9_\/\\.-]+\.[A-Za-z0-9]{1,10}/g;
const message = "can you read sum.c and provide a example output";
const matches = message.match(pattern);
console.log('Matches:', matches);

if (matches) {
    const cleaned = matches.map((entry) => entry.replace(/[\s,;:]+$/, ''));
    console.log('Cleaned:', cleaned);
}
