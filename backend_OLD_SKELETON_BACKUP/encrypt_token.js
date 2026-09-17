const { encrypt } = require('./src/util/crypto');
const newToken = process.argv[2];
console.log(encrypt(newToken));
