
/* ------------------------------------------------------ resolvable entries (v0.2) */
// Demo entries: tcxp:// addresses on existing registries, each pointing to a local file: fixture so resolving
// works offline. Two of them share a path with a virtual note (!tcxp:/firm.demo/rules/tax-year,
// !tcxp:/fleet.demo/env/sea-route): the resolvable and the virtual address are different states.
registerResolvable([
  {address: 'tcxp://firm.demo/rules/tax-year', location: 'file:fixtures/firm-tax-year.md'},
  {address: 'tcxp://firm.demo/env/fiscal-calendar', location: 'file:fixtures/firm-fiscal-calendar.md'},
  {address: 'tcxp://fleet.demo/env/sea-route', location: 'file:fixtures/fleet-sea-route.md'}
]);
