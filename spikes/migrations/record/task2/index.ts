import * as migration_20261118_164300_init from './20261118_164300_init';
import * as migration_20261118_164323_add_coins from './20261118_164323_add_coins';
import * as migration_20261118_164330_add_office from './20261118_164330_add_office';
import * as migration_20261118_164426_remove_coins from './20261118_164426_remove_coins';
import * as migration_20261118_170000_rename_ribbon from './20261118_170000_rename_ribbon';

export const migrations = [
  {
    up: migration_20261118_164300_init.up,
    down: migration_20261118_164300_init.down,
    name: '20261118_164300_init',
  },
  {
    up: migration_20261118_164323_add_coins.up,
    down: migration_20261118_164323_add_coins.down,
    name: '20261118_164323_add_coins',
  },
  {
    up: migration_20261118_164330_add_office.up,
    down: migration_20261118_164330_add_office.down,
    name: '20261118_164330_add_office',
  },
  {
    up: migration_20261118_164426_remove_coins.up,
    down: migration_20261118_164426_remove_coins.down,
    name: '20261118_164426_remove_coins',
  },
  {
    up: migration_20261118_170000_rename_ribbon.up,
    down: migration_20261118_170000_rename_ribbon.down,
    name: '20261118_170000_rename_ribbon'
  },
];
