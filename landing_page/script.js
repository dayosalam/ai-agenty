const header = document.querySelector('[data-header]')
const menuToggle = document.querySelector('[data-menu-toggle]')
const navigation = document.querySelector('[data-nav]')
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const syncNavigationState = () => {
  if (!menuToggle || !navigation) return

  const isClosedMobile = window.innerWidth <= 920 && menuToggle.getAttribute('aria-expanded') !== 'true'
  navigation.toggleAttribute('inert', isClosedMobile)
}

const closeMenu = ({ restoreFocus = false } = {}) => {
  if (!menuToggle || !navigation) return

  const wasOpen = menuToggle.getAttribute('aria-expanded') === 'true'
  menuToggle.setAttribute('aria-expanded', 'false')
  menuToggle.setAttribute('aria-label', 'Open navigation')
  navigation.classList.remove('is-open')
  document.body.classList.remove('menu-open')
  syncNavigationState()

  if (restoreFocus && wasOpen) menuToggle.focus()
}

if (menuToggle && navigation) {
  syncNavigationState()

  menuToggle.addEventListener('click', () => {
    const willOpen = menuToggle.getAttribute('aria-expanded') !== 'true'

    menuToggle.setAttribute('aria-expanded', String(willOpen))
    menuToggle.setAttribute('aria-label', willOpen ? 'Close navigation' : 'Open navigation')
    navigation.classList.toggle('is-open', willOpen)
    document.body.classList.toggle('menu-open', willOpen)
    syncNavigationState()
  })

  navigation.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => closeMenu()))

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu({ restoreFocus: true })
  })

  window.addEventListener('resize', () => {
    if (window.innerWidth > 920) closeMenu()
    else syncNavigationState()
  })
}

const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12)

updateHeader()
window.addEventListener('scroll', updateHeader, { passive: true })

document.querySelectorAll('[data-year]').forEach((element) => {
  element.textContent = new Date().getFullYear()
})

const revealElements = document.querySelectorAll('.reveal')

if (reduceMotion || !('IntersectionObserver' in window)) {
  revealElements.forEach((element) => element.classList.add('is-visible'))
} else {
  const observer = new IntersectionObserver(
    (entries, currentObserver) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        currentObserver.unobserve(entry.target)
      })
    },
    { threshold: 0.12, rootMargin: '0px 0px -45px' },
  )

  revealElements.forEach((element) => observer.observe(element))
}

const demoChat = document.querySelector('[data-demo-chat]')
const demoButtons = [...document.querySelectorAll('[data-demo]')]

const demoConversations = {
  missed: `
    <span class="demo-day">TODAY</span>
    <div class="bubble bubble--student">What did I miss today?<time>6:43 PM</time></div>
    <div class="bubble bubble--peer">
      <p>You have <strong>3 important updates</strong>:</p>
      <ol>
        <li><strong>CSC 301:</strong> Friday's test is at 10 AM in LG7.</li>
        <li><strong>MTH 202:</strong> Today's class moved to LT2.</li>
        <li><strong>GST 201:</strong> The assignment is due tomorrow.</li>
      </ol>
      <span class="bubble-source">Sources: Dr Bello's voice note, class rep update + assignment brief</span>
      <time>6:43 PM</time>
    </div>
    <div class="bubble bubble--student">Where is the MTH class again?<time>6:44 PM</time></div>
    <div class="bubble bubble--peer">Lecture Theatre 2 (LT2). The class rep changed it at 2:08 PM.<time>6:44 PM</time></div>
  `,
  resources: `
    <span class="demo-day">TODAY</span>
    <div class="bubble bubble--student">Send the CSC 301 resources<time>8:16 PM</time></div>
    <div class="bubble bubble--peer">
      <p>I found <strong>4 CSC 301 files</strong> shared since I joined the group:</p>
      <ol>
        <li>Week 4 — Data structures.pdf</li>
        <li>Linked lists — lecture slides.pptx</li>
        <li>2025 past questions.pdf</li>
        <li>Assignment 2 brief.docx</li>
      </ol>
      <span class="bubble-source">Filed from CSC 301 · newest first</span>
      <time>8:16 PM</time>
    </div>
    <div class="bubble bubble--student">Send the second one<time>8:17 PM</time></div>
    <div class="bubble bubble--peer">Here you go: <strong>Linked lists — lecture slides.pptx</strong> (3.1 MB).<time>8:17 PM</time></div>
  `,
  prep: `
    <span class="demo-day">TODAY</span>
    <div class="bubble bubble--student">Quiz me for the CSC 301 test<time>9:03 PM</time></div>
    <div class="bubble bubble--peer">
      <p>I built a five-question practice set from the latest CSC 301 slides and past questions.</p>
      <p><strong>Question 1 of 5:</strong><br />What is the time complexity of inserting an item at the head of a singly linked list?</p>
      <span class="bubble-source">Based on Week 4 slides + 2025 past questions</span>
      <time>9:03 PM</time>
    </div>
    <div class="bubble bubble--student">O(1)<time>9:04 PM</time></div>
    <div class="bubble bubble--peer">Correct ✓ The head pointer changes without traversing the list. Ready for question 2?<time>9:04 PM</time></div>
  `,
}

demoButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const conversation = demoConversations[button.dataset.demo]
    if (!demoChat || !conversation) return

    demoButtons.forEach((currentButton) => {
      const isActive = currentButton === button
      currentButton.classList.toggle('is-active', isActive)
      currentButton.setAttribute('aria-pressed', String(isActive))
    })

    demoChat.style.opacity = '0'
    demoChat.style.transform = 'translateY(5px)'

    window.setTimeout(
      () => {
        demoChat.innerHTML = conversation
        demoChat.style.opacity = '1'
        demoChat.style.transform = 'translateY(0)'
      },
      reduceMotion ? 0 : 140,
    )
  })
})

if (demoChat) {
  demoChat.style.transition = 'opacity 160ms ease, transform 160ms ease'
}

const faqItems = [...document.querySelectorAll('.faq-list details')]

faqItems.forEach((item) => {
  item.addEventListener('toggle', () => {
    if (!item.open) return
    faqItems.forEach((otherItem) => {
      if (otherItem !== item) otherItem.open = false
    })
  })
})
