# Build only inside the reviewed deployment image. This target installs nothing.
CC ?= cc
CFLAGS ?= -O2 -std=c11 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=2
CPPFLAGS += $(shell pkg-config --cflags x11 xtst xi libpng)
LDLIBS += $(shell pkg-config --libs x11 xtst xi libpng)
LDFLAGS += -Wl,-z,relro,-z,now
opendots-linux-desktop: desktop.c
	$(CC) $(CPPFLAGS) $(CFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)
.PHONY: clean
clean:
	rm -f opendots-linux-desktop
