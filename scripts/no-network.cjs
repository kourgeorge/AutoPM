const deny = () => { throw new Error('Network access is disabled during isolated verification'); };
require('http').request = deny;
require('https').request = deny;
global.fetch = deny;
