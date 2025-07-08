(function() {
  // Create container for widget
  const widgetContainer = document.createElement('div');
  widgetContainer.style = `
    position: fixed;
    bottom: 5px;
    right: 5px;
    z-index: 99998;
    width: 600px;
	max-width: 95%;
    height: 95%;
    transition: all 0.3s ease;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    background: #ffffff;
    overflow: hidden;
    display: none;
  `;
  
  // Create iframe for chatbot
  const chatIframe = document.createElement('iframe');
  chatIframe.src = 'https://dissentbot.com';
  chatIframe.style = `
    width: 100%;
    height: 100%;
    border: none;
    background: #ffffff;
  `;
  
  // Create toggle button
  const toggleButton = document.createElement('button');
  toggleButton.style = `
    position: fixed;
    bottom: 5px;
    right: 5px;
    z-index: 99999;
    border-radius: 50%;
    background: #000000;
    color: #ffffff;
    border: none;
    cursor: pointer;
    transition: all 0.3s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    box-shadow: 0 4px 8px rgba(0,0,0,0.2);
	padding: 10px;
  `;
  
  toggleButton.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 2H4C2.9 2 2 2.9 2 4V20L6 16H20C21.1 16 22 15.1 22 14V4C22 2.9 21.1 2 20 2ZM19 11H5V6H19V11Z" fill="white"></path>
    </svg>
  `;
  
  // Toggle functionality
  let isExpanded = false;
  
  toggleButton.addEventListener('click', () => {
    isExpanded = !isExpanded;
    widgetContainer.style.display = isExpanded ? 'block' : 'none';
    
    // Update button position and style
    if (isExpanded) {
      // Button inside widget for closing
      toggleButton.style.position = 'fixed';
	  toggleButton.style.padding = '1px';
      toggleButton.style.bottom = '5px';
      toggleButton.style.right = '5px';
      toggleButton.style.zIndex = '99999';
      toggleButton.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="white"></path>
        </svg>
      `;
    } else {
      // Button outside widget for opening
      toggleButton.style.position = 'fixed';
      toggleButton.style.bottom = '5px';
      toggleButton.style.right = '5px';
      toggleButton.style.top = 'auto';
      toggleButton.style.zIndex = '99999';
      toggleButton.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 2H4C2.9 2 2 2.9 2 4V20L6 16H20C21.1 16 22 15.1 22 14V4C22 2.9 21.1 2 20 2ZM19 11H5V6H19V11Z" fill="white"></path>
        </svg>
      `;
    }
  });
  
  // Append elements to page
  widgetContainer.appendChild(chatIframe);
  document.body.appendChild(widgetContainer);
  document.body.appendChild(toggleButton);
})();