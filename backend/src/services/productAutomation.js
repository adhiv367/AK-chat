function findProduct(message) {

  if (!message) return null;

  const match =
    message.match(/ICK\d+|ICC\d+/i);

  if (!match) return null;

  return {
    id: match[0].toUpperCase()
  };

}

module.exports = {
  findProduct
};