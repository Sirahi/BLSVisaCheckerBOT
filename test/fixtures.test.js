const test = require('node:test');
const assert = require('node:assert');
const { fixtureUrl } = require('./fixtures');

test('fixtureUrl extracts the original portal url', () => {
  assert.match(fixtureUrl('Go_To_Home'), /NewAppointment\?msg=/);
  assert.match(fixtureUrl('Book_Now_Button_Page'), /home\/index$/);
});
