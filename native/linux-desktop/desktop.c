/* Product-owned narrow X11 bridge. No shell, clipboard, file output, keymap
 * mutation, URL, script, or arbitrary executable interface.
 * Native compilation/live-display verification is a separate deployment gate.
 */
#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/XKBlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <X11/extensions/XInput2.h>
#include <png.h>
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/random.h>
#include <unistd.h>

#define MAX_WIDTH 4096
#define MAX_HEIGHT 2160
#define MAX_PIXELS 8847360UL
#define MAX_PNG (16UL * 1024UL * 1024UL)
#define MAX_EVENTS 16384
#define MAX_TEXT_BYTES 16384
typedef struct { int type, a, b, end; } InputEvent;
typedef struct { unsigned char *bytes; size_t length; } PngOutput;
typedef struct { int width, height; char generation[33]; unsigned char keys[256], buttons[256]; } Snapshot;
static InputEvent plan[MAX_EVENTS];
static int plan_count, gesture_count, cancelled;
static const char *display_name;
static void die(const char *code) { fprintf(stderr, "%s\n", code); exit(2); }
static int xerror(Display *display, XErrorEvent *error) { (void)display; (void)error; die("x11_request_failed"); return 0; }
static int xioerror(Display *display) { (void)display; _Exit(2); }
static int integer(const char *value, int low, int high) {
    if (!value || !*value) die("invalid_integer");
    for (const char *p = value; *p; ++p) if (!isdigit((unsigned char)*p)) die("invalid_integer");
    char *end = NULL; long number = strtol(value, &end, 10);
    if (!end || *end || number < low || number > high) die("integer_out_of_bounds");
    return (int)number;
}
static int valid_display(const char *value) {
    if (!value || value[0] != ':') return 0;
    size_t n = strlen(value); if (n < 2 || n > 8) return 0;
    int digits = 0, screen = 0;
    for (size_t i = 1; i < n; i++) {
        if (value[i] == '.' && !screen && digits >= 1 && digits <= 4) { screen = 1; digits = 0; }
        else if (isdigit((unsigned char)value[i])) digits++;
        else return 0;
    }
    return digits >= 1 && digits <= (screen ? 2 : 4);
}
static int valid_generation(const char *value) {
    if (!value || strlen(value) != 32) return 0;
    for (int i = 0; i < 32; ++i) if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return 0;
    return 1;
}
/* Caller holds XGrabServer. Root property lives with this X server, not with
 * a helper process. Existing malformed identity fails closed, never overwrites. */
static void generation(Display *d, Window root, char output[33]) {
    Atom property = XInternAtom(d, "_OPENDOTS_DISPLAY_GENERATION_V1", False), actual;
    int format; unsigned long count, after; unsigned char *value = NULL;
    if (XGetWindowProperty(d, root, property, 0, 64, False, AnyPropertyType, &actual, &format, &count, &after, &value) != Success) die("display_identity_failed");
    if (actual == None) {
        unsigned char random[16]; if (getrandom(random, sizeof(random), 0) != (ssize_t)sizeof(random)) die("display_identity_entropy_failed");
        for (int i = 0; i < 16; i++) snprintf(output + i * 2, 3, "%02x", random[i]);
        XChangeProperty(d, root, property, XA_STRING, 8, PropModeReplace, (const unsigned char *)output, 32);
    } else {
        if (actual != XA_STRING || format != 8 || count != 32 || after != 0) die("display_identity_invalid");
        memcpy(output, value, 32); output[32] = 0;
        if (!valid_generation(output)) die("display_identity_invalid");
    }
    if (value) XFree(value);
}
static void snapshot(Display *d, Window root, Snapshot *s) {
    memset(s, 0, sizeof(*s)); XSync(d, False);
    XWindowAttributes attributes; if (!XGetWindowAttributes(d, root, &attributes)) die("display_geometry_failed");
    s->width = attributes.width; s->height = attributes.height;
    if (s->width < 1 || s->height < 1 || s->width > MAX_WIDTH || s->height > MAX_HEIGHT || (unsigned long)s->width * s->height > MAX_PIXELS) die("display_dimensions_invalid");
    generation(d, root, s->generation);
    char keymap[32]; XQueryKeymap(d, keymap);
    for (int i = 0; i < 256; ++i) s->keys[i] = !!(keymap[i >> 3] & (1 << (i & 7)));
    int opcode, event, error, major = 2, minor = 0;
    if (!XQueryExtension(d, "XInputExtension", &opcode, &event, &error) || XIQueryVersion(d, &major, &minor) != Success) die("input_state_verification_unavailable");
    int count = 0, pointers = 0, keyboards = 0;
    XIDeviceInfo *devices = XIQueryDevice(d, XIAllMasterDevices, &count);
    if (!devices) die("input_state_verification_failed");
    for (int i = 0; i < count; ++i) {
        if (devices[i].use == XIMasterKeyboard) keyboards++;
        if (devices[i].use != XIMasterPointer) continue;
        pointers++;
        Window rr, child; double rx, ry, wx, wy; XIButtonState buttons; XIModifierState mods; XIGroupState group;
        memset(&buttons, 0, sizeof(buttons));
        if (!XIQueryPointer(d, devices[i].deviceid, root, &rr, &child, &rx, &ry, &wx, &wy, &buttons, &mods, &group)) die("pointer_state_verification_failed");
        if (buttons.mask_len < 0 || buttons.mask_len > 32) die("pointer_state_too_large");
        for (int b = 0; b < buttons.mask_len * 8; ++b) if (XIMaskIsSet(buttons.mask, b)) s->buttons[b] = 1;
        if (buttons.mask) XFree(buttons.mask);
    }
    XIFreeDeviceInfo(devices);
    // This driver and x11vnc use the single core-seat XTest route. Multi-seat
    // displays need a different verifier; silently checking only one is unsafe.
    if (pointers != 1 || keyboards != 1) die("multiple_input_seats_unsupported");
    XSync(d, False);
}
static int unheld(const Snapshot *s) { for (int i = 0; i < 256; ++i) if (s->keys[i] || s->buttons[i]) return 0; return 1; }
static void numbers(const unsigned char values[256]) { int first = 1; printf("["); for (int i = 0; i < 256; ++i) if (values[i]) { printf("%s%d", first ? "" : ",", i); first = 0; } printf("]"); }
static void metadata(const Snapshot *s, size_t png_length, int done) {
    printf("{\"protocol\":1,\"display\":\"%s\",\"displayGeneration\":\"%s\",\"width\":%d,\"height\":%d,\"roundTrip\":true,\"inputStateVerified\":true,\"heldKeys\":", display_name, s->generation, s->width, s->height);
    numbers(s->keys); printf(",\"heldButtons\":"); numbers(s->buttons);
    printf(",\"pngBytes\":%zu%s%s}\n", png_length, done ? ",\"done\":true" : "", cancelled ? ",\"cancelled\":true" : ""); fflush(stdout);
}
static void png_output(png_structp png, png_bytep data, png_size_t length) {
    PngOutput *out = png_get_io_ptr(png); if (length > MAX_PNG - out->length) png_error(png, "png_bound");
    memcpy(out->bytes + out->length, data, length); out->length += length;
}
static void png_flush(png_structp png) { (void)png; }
static unsigned char component(unsigned long pixel, unsigned long mask) {
    if (!mask) die("unsupported_visual");
    unsigned shift = 0; while (!(mask & 1)) { mask >>= 1; shift++; }
    return (unsigned char)(((pixel >> shift) & mask) * 255 / mask);
}
static void capture(Display *d, Window root, int require_unheld) {
    Snapshot s; XGrabServer(d); snapshot(d, root, &s);
    if (require_unheld && !unheld(&s)) die("input_still_held");
    XImage *image = XGetImage(d, root, 0, 0, (unsigned)s.width, (unsigned)s.height, AllPlanes, ZPixmap);
    XSync(d, False); XUngrabServer(d); XSync(d, False);
    if (!image || !image->red_mask || !image->green_mask || !image->blue_mask) die("capture_failed");
    PngOutput out = { malloc(MAX_PNG), 0 }; unsigned char *row = malloc((size_t)s.width * 3);
    if (!out.bytes || !row) die("capture_allocation_failed");
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL); if (!png) die("png_initialization_failed");
    png_infop info = png_create_info_struct(png); if (!info || setjmp(png_jmpbuf(png))) die("png_encoding_failed");
    png_set_write_fn(png, &out, png_output, png_flush);
    png_set_IHDR(png, info, (png_uint_32)s.width, (png_uint_32)s.height, 8, PNG_COLOR_TYPE_RGB, PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
    png_write_info(png, info);
    for (int y = 0; y < s.height; y++) {
        for (int x = 0; x < s.width; x++) { unsigned long p = XGetPixel(image, x, y); row[x*3] = component(p, image->red_mask); row[x*3+1] = component(p, image->green_mask); row[x*3+2] = component(p, image->blue_mask); }
        png_write_row(png, row);
    }
    png_write_end(png, info); png_destroy_write_struct(&png, &info); XDestroyImage(image); free(row);
    metadata(&s, out.length, 0); if (fwrite(out.bytes, 1, out.length, stdout) != out.length) die("output_closed"); free(out.bytes); fflush(stdout);
}
static void add_event(int type, int a, int b) { if (plan_count >= MAX_EVENTS) die("input_plan_too_large"); plan[plan_count++] = (InputEvent){ type, a, b, 0 }; }
static void end_gesture(void) { if (!plan_count) die("empty_gesture"); plan[plan_count-1].end=1; gesture_count++; }
static void key_event(int code, int down) { if (code < 8 || code > 255) die("unmapped_key"); add_event(3, code, down); }
static KeySym navigation(const char *name) {
    const char *names[] = {"Enter","Tab","Escape","Backspace","Delete","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End","PageUp","PageDown"};
    KeySym symbols[] = {XK_Return,XK_Tab,XK_Escape,XK_BackSpace,XK_Delete,XK_Up,XK_Down,XK_Left,XK_Right,XK_Home,XK_End,XK_Prior,XK_Next};
    for (size_t i = 0; i < sizeof(symbols)/sizeof(symbols[0]); i++) if (!strcmp(names[i], name)) return symbols[i];
    die("key_not_allowlisted"); return NoSymbol;
}
static void simple_keyboard(Display *d) {
    XkbStateRec state; if (XkbGetState(d, XkbUseCoreKbd, &state) != Success || state.locked_mods || state.latched_mods || state.group != 0) die("unsupported_keyboard_state");
}
static void mapped_character(Display *d, uint32_t character) {
    KeySym sym = character <= 255 ? (KeySym)character : (KeySym)(0x01000000U | character);
    int low, high, found = 0, shift = 0; XDisplayKeycodes(d, &low, &high);
    for (int code = low; code <= high && !found; code++) for (int level = 0; level < 2; level++) if (XkbKeycodeToKeysym(d, (KeyCode)code, 0, level) == sym) { found = code; shift = level; break; }
    if (!found) die("text_character_not_in_current_keymap");
    KeyCode modifier = XKeysymToKeycode(d, XK_Shift_L);
    if (shift) key_event(modifier, 1);
    key_event(found, 1); key_event(found, 0);
    if (shift) key_event(modifier, 0);
    end_gesture();
}
static int nibble(char c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; die("invalid_text_encoding"); return 0; }
static void text_plan(Display *d, const char *hex) {
    size_t hex_length = strlen(hex); if (!hex_length || hex_length % 2 || hex_length > MAX_TEXT_BYTES * 2) die("text_size_invalid");
    unsigned char text[MAX_TEXT_BYTES]; size_t length = hex_length / 2;
    for (size_t i = 0; i < length; i++) text[i] = (unsigned char)((nibble(hex[i*2]) << 4) | nibble(hex[i*2+1]));
    for (size_t i = 0; i < length;) {
        uint32_t cp = text[i++], minimum = 0; int following = 0;
        if (cp >= 0xc2 && cp <= 0xdf) { cp &= 0x1f; following = 1; minimum = 0x80; }
        else if (cp >= 0xe0 && cp <= 0xef) { cp &= 0x0f; following = 2; minimum = 0x800; }
        else if (cp >= 0xf0 && cp <= 0xf4) { cp &= 7; following = 3; minimum = 0x10000; }
        else if (cp >= 0x80) die("invalid_utf8");
        if (i + (size_t)following > length) die("invalid_utf8");
        for (int j = 0; j < following; j++) { if ((text[i] & 0xc0) != 0x80) die("invalid_utf8"); cp = (cp << 6) | (text[i++] & 0x3f); }
        if (cp < minimum || cp < 0x20 || cp == 0x7f || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) die("invalid_text_character");
        mapped_character(d, cp);
    }
}
static void action(Display *d, Window root, int argc, char **argv) {
    if (argc < 2 || !valid_generation(argv[0])) die("invalid_action");
    const char *kind = argv[1];
    char text[MAX_TEXT_BYTES*2+2];
    if (!strcmp(kind,"type")) {
        if (argc != 2) die("invalid_action_shape");
        if (!fgets(text,sizeof(text),stdin)) die("text_input_missing");
        size_t n=strlen(text); if (!n || text[n-1]!='\n') die("text_size_invalid"); text[n-1]=0;
    }
    Snapshot s; XGrabServer(d); snapshot(d, root, &s);
    if (strcmp(s.generation, argv[0])) die("display_generation_changed");
    if (!unheld(&s)) die("input_still_held");
    int event, error, major, minor; if (!XTestQueryExtension(d, &event, &error, &major, &minor)) die("xtest_unavailable");
    if (!strcmp(kind, "move") || !strcmp(kind, "click")) {
        if (argc != (!strcmp(kind,"move") ? 4 : 5)) die("invalid_action_shape");
        add_event(1, integer(argv[2],0,s.width-1), integer(argv[3],0,s.height-1));
        if (!strcmp(kind,"click")) { int button = !strcmp(argv[4],"left") ? 1 : !strcmp(argv[4],"middle") ? 2 : !strcmp(argv[4],"right") ? 3 : 0; if (!button) die("invalid_button"); add_event(2,button,1); add_event(2,button,0); }
        end_gesture();
    } else if (!strcmp(kind,"scroll")) {
        if (argc != 4) die("invalid_action_shape");
        int button = !strcmp(argv[2],"up") ? 4 : !strcmp(argv[2],"down") ? 5 : !strcmp(argv[2],"left") ? 6 : !strcmp(argv[2],"right") ? 7 : 0;
        if (!button) die("invalid_direction");
        int steps = integer(argv[3],1,10);
        for (int i=0; i<steps; i++) { add_event(2,button,1); add_event(2,button,0); end_gesture(); }
    } else if (!strcmp(kind,"key")) {
        if (argc != 3) die("invalid_action_shape");
        simple_keyboard(d);
        if (!strcmp(argv[2],"Ctrl+L") || !strcmp(argv[2],"Ctrl+A")) {
            KeyCode control=XKeysymToKeycode(d,XK_Control_L);
            KeyCode code=XKeysymToKeycode(d,!strcmp(argv[2],"Ctrl+L") ? XK_l : XK_a);
            key_event(control,1); key_event(code,1); key_event(code,0); key_event(control,0);
        } else {
            KeyCode code = XKeysymToKeycode(d, navigation(argv[2])); key_event(code,1); key_event(code,0);
        }
        end_gesture();
    } else if (!strcmp(kind,"type")) {
        simple_keyboard(d); text_plan(d,text);
    } else die("action_not_allowlisted");
    XUngrabServer(d); XSync(d, False);
    int offset=0;
    for (int i=0; i<gesture_count; i++) {
        printf("{\"ready\":%d,\"total\":%d}\n",i,gesture_count); fflush(stdout);
        char permit[8]; if (!fgets(permit,sizeof(permit),stdin)) die("input_permission_missing");
        if (!strcmp(permit,"stop\n")) { cancelled=1; break; }
        if (strcmp(permit,"emit\n")) die("input_permission_missing");
        XGrabServer(d); Snapshot latest; snapshot(d,root,&latest);
        if (strcmp(latest.generation,s.generation) || latest.width!=s.width || latest.height!=s.height) die("display_generation_changed");
        if (!unheld(&latest)) die("input_still_held");
        // One admitted gesture owns its matching release even if the parent
        // revokes authority after its press. At most four events, no sleeps.
        for (;;) {
            if (offset>=plan_count) die("invalid_gesture_plan");
            InputEvent e=plan[offset++]; int ok=e.type==1 ? XTestFakeMotionEvent(d,DefaultScreen(d),e.a,e.b,CurrentTime) : e.type==2 ? XTestFakeButtonEvent(d,(unsigned)e.a,e.b,CurrentTime) : XTestFakeKeyEvent(d,(unsigned)e.a,e.b,CurrentTime);
            if (!ok) die("xtest_emission_failed");
            if (e.end) break;
        }
        XSync(d,False); snapshot(d,root,&latest);
        if (!unheld(&latest)) die("input_still_held");
        XUngrabServer(d); XSync(d,False);
    }
    XGrabServer(d); snapshot(d,root,&s); XUngrabServer(d); XSync(d,False);
    if (!unheld(&s)) die("input_still_held");
    metadata(&s,0,1);
}
int main(int argc, char **argv) {
    alarm(12); // Independent bound even if the parent disappears mid-handshake.
    if (argc < 4 || strcmp(argv[1],"--display") || !valid_display(argv[2])) die("invalid_invocation");
    display_name=argv[2]; XSetErrorHandler(xerror); XSetIOErrorHandler(xioerror);
    Display *d=XOpenDisplay(display_name); if (!d) die("display_unavailable");
    Window root=DefaultRootWindow(d);
    if (!strcmp(argv[3],"capture") || !strcmp(argv[3],"capture-unheld")) { if (argc!=4) die("invalid_invocation"); capture(d,root,!strcmp(argv[3],"capture-unheld")); }
    else if (!strcmp(argv[3],"act")) action(d,root,argc-4,argv+4);
    else die("operation_not_allowlisted");
    XCloseDisplay(d); return 0;
}
