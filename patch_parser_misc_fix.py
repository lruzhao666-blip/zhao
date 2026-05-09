import re

with open('js/parser.js', 'r', encoding='utf-8') as f:
    content = f.read()

# "A Misc: []" is STILL empty because "状态△张辽:疲劳" matches `/[^\s]+△/.test(line)`, anchor becomes null.
# Then the loop goes to:
# ```
#      } else {
#        // 未知锚点容错
#        if (/△/.test(line) && anchor === null && !/^[金粮兵民心城]△/.test(line)) {
#            change.misc.push(line);
#        }
#      }
# ```
# Wait! In the loop:
# `if (/^[^\s]+△/.test(line)) { anchor = null; }`
# Then the `else` block belongs to `if (anchor === 'intel')`.
# If `anchor` is reset to `null` right before it, does it trigger the `else`?
# Ah:
# `if (anchor === 'breakdown') { ... } else if (anchor === 'dark') { ... } else if (anchor === 'seasonal') { ... } else if (anchor === 'intel') { ... } else { ... }`
# BUT I placed `if (/[^\s]+△/.test(line)) { anchor = null; }` BEFORE the `if (anchor === 'breakdown')` chain?
# Let's check `parser.js`.
