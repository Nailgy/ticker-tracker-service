# Development Guide

**Status**: ✅ Phase 1 Architecture Stable  
**Last Updated**: 2026-04-14  

---

## Contributing

### Code Standards

- **Language**: Node.js ES2020+ (async/await, arrow functions, classes)
- **Line length**: Max 120 characters
- **Indentation**: 2 spaces
- **Formatting**: Prettier (run `npm run format`)
- **Linting**: ESLint (run `npm run lint`)
- **Comments**: Only for non-obvious logic

### Tools

```bash
npm run format        # Auto-format code
npm run format:check  # Check formatting
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
npm test              # All tests
npm test:coverage     # Coverage report
```

---

## Architecture Rules (Phase 1 Contracts)

### ✅ DO:

1. **Use public methods only** for inter-module communication
   ```javascript
   // ✅ OK
   registry.addSymbols(symbols);
   
   // ❌ NO
   registry.desiredSymbols.add(symbol);  // Direct state access
   ```

2. **Encapsulate state mutations** in owning module
   ```javascript
   // ✅ Registry owns symbol state
   // Only MarketRegistry.addSymbols/removeSymbols can modify
   
   // ❌ NO: External code changing registry state
   // registry.activeSymbols.delete(symbol);
   ```

3. **Return fresh Set/Object copies** from getters
   ```javascript
   // ✅ OK
   getActiveSymbols() {
     return new Set(this.activeSymbols);  // Fresh copy
   }
   
   // ❌ NO: Return reference
   // return this.activeSymbols;  // Can be mutated externally
   ```

4. **Use callbacks for event delivery**
   ```javascript
   // ✅ OK
   engine.onTicker(callback);
   
   // ❌ NO: Direct method calls
   // Don't: tickerWatcher.onTicker = callback;
   ```

5. **Add metrics to status objects** for observability
   ```javascript
   // ✅ Every module has getMetrics() or getStatus()
   getStatus() {
     return {
       isRunning: this.isRunning,
       symbolCount: this.symbols.size,
       activeConnections: this.loops.size,
       failedBatches: this.failed,
     };
   }
   ```

6. **Test components in isolation** with mocks
   ```javascript
   // ✅ Unit tests mock dependencies
   jest.mock('../../src/services/redis.service');
   
   const engine = new SubscriptionEngine(mockAdapter, mockRegistry, mockWriter);
   ```

---

### ❌ DON'T:

1. **Call _privateMethod across modules**
   ```javascript
   // ❌ NO
   engine._subscriptionLoop(batchId);
   registry._updateMetrics();
   ```

2. **Directly mutate external state**
   ```javascript
   // ❌ NO
   manager.batches[0].push('NEW/SYMBOL');
   registry.activeSymbols.add('X/Y');
   ```

3. **Return internal references**
   ```javascript
   // ❌ NO
   return this.activeSymbols;      // Users can mutate
   return this.batches;            // External changes affect component
   ```

4. **Skip error handling**
   ```javascript
   // ❌ NO
   await adapter.initialize();  // Ignore errors
   
   // ✅ OK
   try {
     await adapter.initialize();
   } catch (error) {
     onError(error);
   }
   ```

5. **Add upward dependencies**
   ```javascript
   // ✅ OK: SubscriptionEngine depends on MarketRegistry
   // ❌ NO: MarketRegistry depending on SubscriptionEngine
   ```

6. **Introduce circular imports**
   ```javascript
   // ✅ Clean: A → B → C (no cycles)
   // ❌ NO: A → B → A (circular)
   ```

---

## Adding New Modules

### Step-by-Step

1. **Create module file** in appropriate directory:
   ```bash
   src/core/new-module.js
   src/services/new-service.js
   src/adapters/new-adapter.js
   src/utils/new-util.js
   ```

2. **Implement public methods only**:
   ```javascript
   class NewModule {
     constructor(dependencies) {
       this.dep1 = dependencies.dep1;  // Receive via injection
       // Don't: const x = require('./other'); // No upward deps
     }
     
     // Public API
     async doSomething() { }
     getStatus() { return {...}; }
     
     // Private helper (prefix with _)
     _internalHelper() { }
   }
   ```

3. **Follow dependency injection** pattern:
   ```javascript
   // ✅ Inject dependencies
   const module = new NewModule(adapter, registry, writer);
   
   // ❌ Don't create dependencies
   // const adapter = new ExchangeAdapter(); // This breaks modularity
   ```

4. **Export from module**:
   ```javascript
   module.exports = NewModule;
   ```

5. **Add unit tests** in tests/unit/:
   ```bash
   # tests/unit/new-module.test.js
   
   jest.mock('../../src/services/dependency1');
   const NewModule = require('../../src/core/new-module');
   
   describe('NewModule', () => {
     // Tests
   });
   ```

6. **Add integration tests** if cross-module:
   ```bash
   # tests/integration/new-flow.integration.test.js
   # Test end-to-end data flow with real module + mocks
   ```

7. **Document in API_REFERENCE.md**:
   ```markdown
   ## NewModule
   
   ### Methods
   
   #### async doSomething()
   Purpose: ...
   Returns: ...
   ```

8. **Update ARCHITECTURE.md**:
   - Add to Module Responsibility Map
   - Update dependency diagram
   - Update data flow if affected

---

## Testing Patterns

### Unit Test Structure

```javascript
const Module = require('../../src/component/module');

describe('Module', () => {
  let module;
  let mockDependency;
  
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    mockDependency = { /* mock interface */ };
    module = new Module(mockDependency);
  });
  
  afterEach(() => {
    jest.useRealTimers();
  });
  
  describe('Public Method', () => {
    it('should do X', () => {
      // Test
    });
    
    it('should handle errors', () => {
      // Test error case
    });
  });
});
```

### Mock Patterns

**Jest.mock() for dependencies**:
```javascript
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    pipeline: jest.fn().mockReturnValue(mockPipeline),
  }));
});
```

**Jest.fn() for callbacks**:
```javascript
const callback = jest.fn();
engine.onTicker(callback);
// Later...
expect(callback).toHaveBeenCalledWith({symbol, ticker});
```

**Jest.useFakeTimers() for async**:
```javascript
jest.useFakeTimers();
// Code that schedules timers
jest.advanceTimersByTime(1000);
// Timers execute
```

---

## Code Review Checklist

Before submitting PR:

- [ ] `npm test` passes (all tests green)
- [ ] `npm run lint` passes (no eslint violations)
- [ ] `npm run format:check` passes (code formatted)
- [ ] No `console.log` in production code
- [ ] Error messages are helpful
- [ ] Public methods documented
- [ ] Private methods prefixed with `_`
- [ ] No circular dependencies introduced
- [ ] State encapsulation maintained
- [ ] Tests added for new logic
- [ ] ARCHITECTURE.md updated if structural change
- [ ] API_REFERENCE.md updated if public API changed

---

## Debugging Tips

### Enable Debug Logging
```javascript
// In module
if (process.env.DEBUG) {
  console.log('Debug info', value);
}

// Run with
DEBUG=1 npm start
```

### Use Debugger
```bash
# Start with Node debugger
node --inspect src/index.js

# Then open in Chrome: chrome://inspect
```

### Test Single File
```bash
npm test tests/unit/module.test.js

# Watch mode
npm test -- --watch tests/unit/module.test.js
```

### Coverage Report
```bash
npm run test:coverage

# See which lines untested
# open coverage/lcov-report/index.html
```

---

## Performance Profiling

### Memory Profiling
```bash
node --inspect --max-old-space-size=4096 src/index.js
# Chrome DevTools → Memory → Take snapshot
```

### CPU Profiling
```bash
node --prof src/index.js
# mv *.log profile.txt && node --prof-process profile.txt > output.txt
```

---

## Phase 1 Architecture is Stable

✅ No breaking changes expected in 2-3 releases  
✅ Extension points documented for Phase 2+  
✅ Interface contracts frozen  

---

## Release Process

1. Bump version: `npm version patch|minor|major`
2. Run tests: `npm test`
3. Create tag: `git tag v1.x.x`
4. Push: `git push && git push --tags`
5. Create release notes
6. Publish to npm if applicable

---

## Questions or Issues?

- Check `/docs/ARCHITECTURE.md` for design decisions
- Check `/docs/API_REFERENCE.md` for module contracts
- Run existing tests as examples
- Check `/docs/TROUBLESHOOTING.md` for common issues
